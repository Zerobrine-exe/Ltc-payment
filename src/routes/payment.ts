import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();

const LITOSHI_PER_LTC = 100_000_000;
const CONFIRMATIONS_REQUIRED = 1;
const AMOUNT_TOLERANCE_RATIO = 0.05;
const DEFAULT_LOOKBACK_MS = 60 * 60 * 1000; // how far back a matching payment is allowed to have happened, relative to the request time
const PROVIDER_TIMEOUT_MS = 8000;

interface NormalizedTx {
  txHash: string;
  valueLitoshis: number;
  confirmations: number;
  timeMs: number;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface BlockCypherTxRef {
  tx_hash: string;
  value: number;
  confirmations: number;
  confirmed?: string;
  received?: string;
}

interface BlockCypherAddress {
  address: string;
  txrefs?: BlockCypherTxRef[];
  unconfirmed_txrefs?: BlockCypherTxRef[];
}

async function fetchFromBlockCypher(address: string): Promise<NormalizedTx[]> {
  const token = process.env.BLOCKCYPHER_TOKEN;
  const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
  const res = await fetchWithTimeout(
    `https://api.blockcypher.com/v1/ltc/main/addrs/${encodeURIComponent(address)}?limit=50${tokenParam}`,
    PROVIDER_TIMEOUT_MS,
  );
  if (!res.ok) {
    throw new Error(`BlockCypher responded with status ${res.status}`);
  }
  const data = (await res.json()) as BlockCypherAddress;
  const allTxs = [...(data.txrefs ?? []), ...(data.unconfirmed_txrefs ?? [])];
  return allTxs.map((tx) => {
    const timeStr = tx.confirmed ?? tx.received;
    return {
      txHash: tx.tx_hash,
      valueLitoshis: tx.value,
      confirmations: tx.confirmations,
      timeMs: timeStr ? new Date(timeStr).getTime() : Date.now(),
    };
  });
}

interface SoChainTx {
  txid: string;
  confirmations: string | number;
  time: number;
  value: string;
}

interface SoChainResponse {
  status: string;
  data?: { txs?: SoChainTx[] };
}

async function fetchFromSoChain(address: string): Promise<NormalizedTx[]> {
  const res = await fetchWithTimeout(
    `https://sochain.com/api/v2/get_tx_received/LTC/${encodeURIComponent(address)}`,
    PROVIDER_TIMEOUT_MS,
  );
  if (!res.ok) {
    throw new Error(`SoChain responded with status ${res.status}`);
  }
  const data = (await res.json()) as SoChainResponse;
  if (data.status !== "success" || !data.data?.txs) {
    throw new Error("SoChain returned an unexpected response");
  }
  return data.data.txs.map((tx) => ({
    txHash: tx.txid,
    valueLitoshis: Math.round(Number(tx.value) * LITOSHI_PER_LTC),
    confirmations: Number(tx.confirmations),
    timeMs: tx.time * 1000,
  }));
}

interface BlockchairAddressData {
  data?: Record<string, { transactions?: string[] }>;
  context?: { state?: number };
}

interface BlockchairTxOutput {
  recipient: string;
  value: number;
}

interface BlockchairTxEntry {
  transaction?: { block_id?: number; time?: string };
  outputs?: BlockchairTxOutput[];
}

interface BlockchairTxData {
  data?: Record<string, BlockchairTxEntry>;
}

async function fetchFromBlockchair(address: string): Promise<NormalizedTx[]> {
  const dashRes = await fetchWithTimeout(
    `https://api.blockchair.com/litecoin/dashboards/address/${encodeURIComponent(address)}?limit=50`,
    PROVIDER_TIMEOUT_MS,
  );
  if (!dashRes.ok) {
    throw new Error(`Blockchair responded with status ${dashRes.status}`);
  }
  const dash = (await dashRes.json()) as BlockchairAddressData;
  const addrEntry = dash.data?.[address];
  if (!addrEntry) {
    throw new Error("Blockchair returned no data for this address");
  }
  const txHashes = addrEntry.transactions ?? [];
  if (txHashes.length === 0) {
    return [];
  }
  const tipHeight = dash.context?.state ?? 0;

  const txRes = await fetchWithTimeout(
    `https://api.blockchair.com/litecoin/dashboards/transaction/${txHashes.slice(0, 50).join(",")}`,
    PROVIDER_TIMEOUT_MS,
  );
  if (!txRes.ok) {
    throw new Error(`Blockchair transaction lookup responded with status ${txRes.status}`);
  }
  const txData = (await txRes.json()) as BlockchairTxData;

  const results: NormalizedTx[] = [];
  for (const hash of txHashes) {
    const entry = txData.data?.[hash];
    if (!entry) continue;
    const matchingOutput = (entry.outputs ?? []).find((output) => output.recipient === address);
    if (!matchingOutput) continue;
    const blockId = entry.transaction?.block_id ?? -1;
    const confirmations = blockId > 0 ? Math.max(tipHeight - blockId + 1, 0) : 0;
    const timeStr = entry.transaction?.time;
    results.push({
      txHash: hash,
      valueLitoshis: matchingOutput.value,
      confirmations,
      timeMs: timeStr ? new Date(`${timeStr}Z`).getTime() : Date.now(),
    });
  }
  return results;
}

const PROVIDERS: Array<{ name: string; fetchTxs: (address: string) => Promise<NormalizedTx[]> }> = [
  { name: "BlockCypher", fetchTxs: fetchFromBlockCypher },
  { name: "SoChain", fetchTxs: fetchFromSoChain },
  { name: "Blockchair", fetchTxs: fetchFromBlockchair },
];

async function fetchTransactions(
  address: string,
  log: Request["log"],
): Promise<{ txs: NormalizedTx[]; provider: string }> {
  const errors: string[] = [];
  for (const provider of PROVIDERS) {
    try {
      const txs = await provider.fetchTxs(address);
      return { txs, provider: provider.name };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${provider.name}: ${message}`);
      log.warn({ provider: provider.name, address, error: message }, "LTC data provider failed, trying next");
    }
  }
  throw new Error(`All LTC data providers failed: ${errors.join("; ")}`);
}

function isApiKeyValid(req: Request): boolean {
  const provided = req.header("x-api-key") ?? req.query.key;
  const expected = process.env.LTC_PAYMENT_API_SECRET;
  return typeof provided === "string" && typeof expected === "string" && provided === expected;
}

router.get("/private/:address/:amount/:beforetime", async (req: Request, res: Response) => {
  if (!isApiKeyValid(req)) {
    res.status(401).json({ status: "error", message: "Invalid or missing API key" });
    return;
  }

  const address = String(req.params.address ?? "");
  const amount = String(req.params.amount ?? "");
  const beforetime = String(req.params.beforetime ?? "");
  const targetAmount = Number(amount);
  const deadline = Number(beforetime);

  if (!address || Number.isNaN(targetAmount) || targetAmount <= 0) {
    res.status(400).json({ status: "error", message: "Invalid address or amount" });
    return;
  }
  if (Number.isNaN(deadline) || deadline <= 0) {
    res.status(400).json({
      status: "error",
      message: "Invalid beforetime — must be a unix timestamp (seconds or milliseconds)",
    });
    return;
  }

  const deadlineMs = deadline < 10_000_000_000 ? deadline * 1000 : deadline;
  const requestTimeMs = Date.now();

  const rawStart = req.query.start;
  const startParam = Number(Array.isArray(rawStart) ? rawStart[0] : rawStart);
  const hasExplicitStart = Number.isFinite(startParam) && startParam > 0;
  const startMs = hasExplicitStart
    ? (startParam < 10_000_000_000 ? startParam * 1000 : startParam)
    : undefined;

  if (startMs !== undefined && startMs >= deadlineMs) {
    res.status(400).json({
      status: "error",
      message: "start must be before beforetime",
    });
    return;
  }

  // If the client didn't pass an explicit `start` (the moment they began waiting for
  // payment), fall back to a rolling lookback window relative to *this* request's time.
  const rawLookback = req.query.lookbackSeconds;
  const lookbackSeconds = Number(Array.isArray(rawLookback) ? rawLookback[0] : rawLookback);
  const lookbackMs = Number.isFinite(lookbackSeconds) && lookbackSeconds > 0
    ? lookbackSeconds * 1000
    : DEFAULT_LOOKBACK_MS;

  const windowStartMs = startMs ?? requestTimeMs - lookbackMs;

  try {
    const { txs: allTxs, provider } = await fetchTransactions(address, req.log);

    const targetLitoshis = targetAmount * LITOSHI_PER_LTC;
    const toleranceLitoshis = Math.max(targetLitoshis * AMOUNT_TOLERANCE_RATIO, 1000);

    const matches = allTxs.filter((tx) => {
      const withinAmount = Math.abs(tx.valueLitoshis - targetLitoshis) <= toleranceLitoshis;
      const withinDeadline = tx.timeMs <= deadlineMs;
      const withinWindow = tx.timeMs >= windowStartMs;
      return withinAmount && withinDeadline && withinWindow;
    });

    const confirmedMatch = matches
      .filter((tx) => tx.confirmations >= CONFIRMATIONS_REQUIRED)
      .sort((a, b) => b.confirmations - a.confirmations)[0];

    if (confirmedMatch) {
      res.json({
        status: "confirmed",
        message: "Payment confirmed",
        address,
        expectedAmountLtc: targetAmount,
        receivedAmountLtc: confirmedMatch.valueLitoshis / LITOSHI_PER_LTC,
        txHash: confirmedMatch.txHash,
        confirmations: confirmedMatch.confirmations,
        dataProvider: provider,
      });
      return;
    }

    const pendingMatch = matches.sort((a, b) => b.confirmations - a.confirmations)[0];
    if (pendingMatch) {
      res.json({
        status: "pending",
        message: `Payment detected, waiting for confirmations (${pendingMatch.confirmations}/${CONFIRMATIONS_REQUIRED})`,
        address,
        expectedAmountLtc: targetAmount,
        receivedAmountLtc: pendingMatch.valueLitoshis / LITOSHI_PER_LTC,
        txHash: pendingMatch.txHash,
        confirmations: pendingMatch.confirmations,
        dataProvider: provider,
      });
      return;
    }

    const expired = requestTimeMs > deadlineMs;
    res.json({
      status: expired ? "expired" : "waiting",
      message: expired
        ? "No matching payment received before the deadline"
        : "No matching payment received yet — keep polling",
      address,
      expectedAmountLtc: targetAmount,
      beforeTime: new Date(deadlineMs).toISOString(),
      windowStart: new Date(windowStartMs).toISOString(),
      dataProvider: provider,
    });
  } catch (error) {
    req.log.error({ error, address }, "All LTC data providers failed");
    res.status(502).json({ status: "error", message: "Unable to reach any LTC network data provider" });
  }
});

export default router;
