import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();

const LITOSHI_PER_LTC = 100_000_000;
const CONFIRMATIONS_REQUIRED = 1;
const AMOUNT_TOLERANCE_RATIO = 0.05;

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

  const { address, amount, beforetime } = req.params;
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

  try {
    const response = await fetch(
      `https://api.blockcypher.com/v1/ltc/main/addrs/${encodeURIComponent(address)}?limit=50`,
    );

    if (!response.ok) {
      req.log.error({ status: response.status, address }, "BlockCypher request failed");
      res.status(502).json({ status: "error", message: "Unable to reach LTC network data provider" });
      return;
    }

    const data = (await response.json()) as BlockCypherAddress;
    const allTxs = [...(data.txrefs ?? []), ...(data.unconfirmed_txrefs ?? [])];

    const targetLitoshis = targetAmount * LITOSHI_PER_LTC;
    const toleranceLitoshis = Math.max(targetLitoshis * AMOUNT_TOLERANCE_RATIO, 1000);

    const matches = allTxs.filter((tx) => {
      const withinAmount = Math.abs(tx.value - targetLitoshis) <= toleranceLitoshis;
      const txTimeStr = tx.confirmed ?? tx.received;
      const txTimeMs = txTimeStr ? new Date(txTimeStr).getTime() : Date.now();
      const withinDeadline = txTimeMs <= deadlineMs;
      return withinAmount && withinDeadline;
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
        receivedAmountLtc: confirmedMatch.value / LITOSHI_PER_LTC,
        txHash: confirmedMatch.tx_hash,
        confirmations: confirmedMatch.confirmations,
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
        receivedAmountLtc: pendingMatch.value / LITOSHI_PER_LTC,
        txHash: pendingMatch.tx_hash,
        confirmations: pendingMatch.confirmations,
      });
      return;
    }

    const expired = Date.now() > deadlineMs;
    res.json({
      status: expired ? "expired" : "waiting",
      message: expired
        ? "No matching payment received before the deadline"
        : "No matching payment received yet — keep polling",
      address,
      expectedAmountLtc: targetAmount,
      beforeTime: new Date(deadlineMs).toISOString(),
    });
  } catch (error) {
    req.log.error({ error, address }, "Error checking LTC payment");
    res.status(500).json({ status: "error", message: "Internal error checking payment status" });
  }
});

export default router;
