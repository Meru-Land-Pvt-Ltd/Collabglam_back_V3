const Stripe = require("stripe");
const { ApiResponse } = require("../core/http/ApiResponse");
const { HttpStatus } = require("../core/http/HttpStatus");
const { BrandWalletModel } = require("../models/brandWallet");
const saveErrorLog = require("../services/errorLog.service");

// ---------------- Helpers ----------------
const clean = (v) => String(v ?? "").trim();

const getRequestId = (req) =>
  req.requestId || req.id || req.headers?.["x-request-id"] || "NA";

const EC = (code) => code;

const toNumber = (v, def = 0) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;

  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }

  return def;
};

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

const syncWalletBalances = (wallet) => {
  wallet.walletBalance = Math.max(0, roundMoney(wallet.walletBalance));
  wallet.escrowBalance = Math.max(
    0,
    roundMoney(wallet.escrowBalance ?? wallet.frozenBalance ?? 0)
  );

  // Keep this old field as an alias so existing UI/API consumers keep working.
  wallet.frozenBalance = wallet.escrowBalance;

  // Old frontend code sometimes reads usableBalance. In the single-wallet model,
  // usableBalance equals walletBalance because escrow has already been moved out.
  wallet.usableBalance = wallet.walletBalance;

  return {
    walletBalance: wallet.walletBalance,
    escrowBalance: wallet.escrowBalance,
    frozenBalance: wallet.frozenBalance,
    usableBalance: wallet.usableBalance,
  };
};

const getOrCreateWallet = async (brandId, session = null) => {
  let query = BrandWalletModel.findOne({ brandId });
  if (session) query = query.session(session);

  let wallet = await query;

  if (!wallet) {
    wallet = new BrandWalletModel({
      brandId,
      walletBalance: 0,
      escrowBalance: 0,
      frozenBalance: 0,
      topups: [],
      escrowHistories: [],
      withdrawHistories: [],
      freezes: [],
      freezeHistories: [],
      allocationHistories: [],
    });
  }

  syncWalletBalances(wallet);

  if (session) {
    await wallet.save({ session });
  } else {
    await wallet.save();
  }

  return wallet;
};

const pushEscrowHistory = (wallet, payload = {}) => {
  wallet.escrowHistories = Array.isArray(wallet.escrowHistories)
    ? wallet.escrowHistories
    : [];

  wallet.escrowHistories.push({
    brandId: clean(payload.brandId || wallet.brandId),
    type: clean(payload.type || "milestone_escrow"),
    amount: roundMoney(payload.amount),
    currency: clean(payload.currency || "usd").toLowerCase(),
    campaignId: clean(payload.campaignId),
    influencerId: clean(payload.influencerId),
    contractId: clean(payload.contractId),
    milestoneId: clean(payload.milestoneId),
    milestoneHistoryId: clean(payload.milestoneHistoryId),
    milestoneTitle: clean(payload.milestoneTitle),
    walletBalanceBefore: roundMoney(payload.walletBalanceBefore),
    walletBalanceAfter: roundMoney(payload.walletBalanceAfter),
    escrowBalanceBefore: roundMoney(payload.escrowBalanceBefore),
    escrowBalanceAfter: roundMoney(payload.escrowBalanceAfter),
    note: clean(payload.note),
    createdAt: new Date(),
  });

  wallet.markModified("escrowHistories");
};

const moveAmountToEscrow = (wallet, {
  amount,
  type = "milestone_escrow",
  currency = "usd",
  campaignId = "",
  influencerId = "",
  contractId = "",
  milestoneId = "",
  milestoneHistoryId = "",
  milestoneTitle = "",
  note = "",
} = {}) => {
  const amountNum = roundMoney(amount);
  const before = syncWalletBalances(wallet);

  if (!amountNum || amountNum <= 0) {
    const err = new Error("amount must be > 0");
    err.status = 400;
    throw err;
  }

  if (before.walletBalance < amountNum) {
    const err = new Error("Insufficient brand wallet balance. Please top up the remaining amount.");
    err.status = 402;
    err.extra = {
      walletBalance: before.walletBalance,
      escrowBalance: before.escrowBalance,
      frozenBalance: before.frozenBalance,
      usableBalance: before.usableBalance,
      requiredAmount: amountNum,
      needToAdd: roundMoney(amountNum - before.walletBalance),
    };
    throw err;
  }

  wallet.walletBalance = roundMoney(before.walletBalance - amountNum);
  wallet.escrowBalance = roundMoney(before.escrowBalance + amountNum);
  wallet.frozenBalance = wallet.escrowBalance;
  wallet.usableBalance = wallet.walletBalance;

  const after = syncWalletBalances(wallet);

  pushEscrowHistory(wallet, {
    brandId: wallet.brandId,
    type,
    amount: amountNum,
    currency,
    campaignId,
    influencerId,
    contractId,
    milestoneId,
    milestoneHistoryId,
    milestoneTitle,
    walletBalanceBefore: before.walletBalance,
    walletBalanceAfter: after.walletBalance,
    escrowBalanceBefore: before.escrowBalance,
    escrowBalanceAfter: after.escrowBalance,
    note,
  });

  return after;
};

const refundAmountFromEscrow = (wallet, {
  amount,
  type = "milestone_escrow_refund",
  currency = "usd",
  campaignId = "",
  influencerId = "",
  contractId = "",
  milestoneId = "",
  milestoneHistoryId = "",
  milestoneTitle = "",
  note = "",
} = {}) => {
  const amountNum = roundMoney(amount);
  const before = syncWalletBalances(wallet);
  const refundAmount = Math.min(amountNum, before.escrowBalance);

  if (!refundAmount || refundAmount <= 0) return before;

  wallet.walletBalance = roundMoney(before.walletBalance + refundAmount);
  wallet.escrowBalance = roundMoney(before.escrowBalance - refundAmount);
  wallet.frozenBalance = wallet.escrowBalance;
  wallet.usableBalance = wallet.walletBalance;

  const after = syncWalletBalances(wallet);

  pushEscrowHistory(wallet, {
    brandId: wallet.brandId,
    type,
    amount: refundAmount,
    currency,
    campaignId,
    influencerId,
    contractId,
    milestoneId,
    milestoneHistoryId,
    milestoneTitle,
    walletBalanceBefore: before.walletBalance,
    walletBalanceAfter: after.walletBalance,
    escrowBalanceBefore: before.escrowBalance,
    escrowBalanceAfter: after.escrowBalance,
    note,
  });

  return after;
};

const releaseAmountFromEscrow = (wallet, {
  amount,
  currency = "usd",
  campaignId = "",
  influencerId = "",
  contractId = "",
  milestoneId = "",
  milestoneHistoryId = "",
  milestoneTitle = "",
  note = "",
} = {}) => {
  const amountNum = roundMoney(amount);
  const before = syncWalletBalances(wallet);

  if (!amountNum || amountNum <= 0) {
    const err = new Error("amount must be > 0");
    err.status = 400;
    throw err;
  }

  if (before.escrowBalance < amountNum) {
    const err = new Error("Escrow balance is less than milestone amount.");
    err.status = 400;
    err.extra = {
      escrowBalance: before.escrowBalance,
      frozenBalance: before.frozenBalance,
      releaseAmount: amountNum,
    };
    throw err;
  }

  wallet.escrowBalance = roundMoney(before.escrowBalance - amountNum);
  wallet.frozenBalance = wallet.escrowBalance;
  wallet.usableBalance = wallet.walletBalance;

  const after = syncWalletBalances(wallet);

  pushEscrowHistory(wallet, {
    brandId: wallet.brandId,
    type: "milestone_release",
    amount: amountNum,
    currency,
    campaignId,
    influencerId,
    contractId,
    milestoneId,
    milestoneHistoryId,
    milestoneTitle,
    walletBalanceBefore: before.walletBalance,
    walletBalanceAfter: after.walletBalance,
    escrowBalanceBefore: before.escrowBalance,
    escrowBalanceAfter: after.escrowBalance,
    note,
  });

  return after;
};

let stripeClient = null;

const getStripeClient = () => {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }

  if (!stripeClient) {
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }

  return stripeClient;
};

// ======================================================================
// GET /brand-wallet?brandId=xxxx
// ======================================================================
const getBrandWallet = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(
      typeof req.query.brandId === "string" ? req.query.brandId : ""
    );

    if (!brandId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Valid brandId is required",
        requestId
      );
    }

    const wallet = await BrandWalletModel.findOne({ brandId });

    if (!wallet) {
      return ApiResponse.sendOk(
        res,
        HttpStatus.OK,
        {
          brandId,
          walletBalance: 0,
          escrowBalance: 0,
          frozenBalance: 0,
          usableBalance: 0,
          topups: [],
          escrowHistories: [],
        },
        requestId
      );
    }

    const snap = syncWalletBalances(wallet);
    await wallet.save();

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        brandId,
        ...snap,
        topups: wallet.topups || [],
        escrowHistories: wallet.escrowHistories || [],
        withdrawHistories: wallet.withdrawHistories || [],
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, 500, "GET_BRAND_WALLET_ERROR");
    const message = err instanceof Error ? err.message : "Internal error";

    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

// ======================================================================
// POST /brand-wallet/topup
// body: { brandId, amount, currency, successUrl, cancelUrl }
// Creates Stripe Checkout Session to add available walletBalance.
// ======================================================================
const topupBrandWallet = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(req.body.brandId);
    const amount = roundMoney(Math.max(0, toNumber(req.body.amount, 0)));
    const currency = clean(req.body.currency || "usd").toLowerCase();
    const successUrl = clean(req.body.successUrl);
    const cancelUrl = clean(req.body.cancelUrl);

    if (!brandId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Valid brandId is required",
        requestId
      );
    }

    if (!amount || amount <= 0) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "amount must be > 0",
        requestId
      );
    }

    if (!successUrl || !cancelUrl) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "successUrl and cancelUrl are required",
        requestId
      );
    }

    const stripe = getStripeClient();

    await getOrCreateWallet(brandId);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      success_url: successUrl,
      cancel_url: cancelUrl,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency,
            unit_amount: Math.round(amount * 100),
            product_data: {
              name: "Brand wallet topup",
              description: `Wallet topup for brand ${brandId}`,
            },
          },
        },
      ],
      metadata: {
        kind: "brand_wallet_topup",
        brandId,
        amount: String(amount),
        currency,
      },
    });

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "Stripe checkout session created",
        brandId,
        amount,
        currency,
        sessionId: session.id,
        checkoutUrl: session.url,
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, 500, "TOPUP_BRAND_WALLET_ERROR");
    const message = err instanceof Error ? err.message : "Internal error";

    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

// ======================================================================
// POST /brand-wallet/topup/confirm
// body: { brandId, sessionId }
// Verifies Stripe payment and credits available walletBalance only.
// ======================================================================
const confirmBrandWalletTopup = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(req.body.brandId);
    const sessionId = clean(req.body.sessionId);

    if (!brandId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Valid brandId is required",
        requestId
      );
    }

    if (!sessionId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "sessionId is required",
        requestId
      );
    }

    if (sessionId === "{CHECKOUT_SESSION_ID}") {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Invalid Stripe sessionId placeholder received. The successUrl must keep {CHECKOUT_SESSION_ID} unencoded.",
        requestId
      );
    }

    const stripe = getStripeClient();

    const stripeSession = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent"],
    });

    if (!stripeSession) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.NOT_FOUND,
        EC("NOT_FOUND"),
        "Stripe session not found",
        requestId
      );
    }

    if (clean(stripeSession.metadata?.brandId) !== brandId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "brandId does not match Stripe session",
        requestId
      );
    }

    if (stripeSession.payment_status !== "paid") {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("PAYMENT_NOT_COMPLETED"),
        "Stripe payment is not completed",
        requestId
      );
    }

    const amount = roundMoney(toNumber(stripeSession.amount_total, 0) / 100);
    const currency = clean(stripeSession.currency || "usd").toLowerCase();

    if (!amount || amount <= 0) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Invalid paid amount received from Stripe",
        requestId
      );
    }

    const wallet = await getOrCreateWallet(brandId);

    wallet.topups = Array.isArray(wallet.topups) ? wallet.topups : [];

    const alreadyCredited = wallet.topups.some(
      (t) =>
        clean(t?.stripeSessionId) === stripeSession.id &&
        clean(t?.status).toLowerCase() === "success"
    );

    if (!alreadyCredited) {
      const walletBalanceBefore = roundMoney(wallet.walletBalance);
      const walletBalanceAfter = roundMoney(walletBalanceBefore + amount);

      wallet.walletBalance = walletBalanceAfter;

      wallet.topups.push({
        amount,
        currency,
        status: "success",
        source: "stripe",
        stripeSessionId: stripeSession.id,
        stripePaymentIntentId:
          typeof stripeSession.payment_intent === "string"
            ? stripeSession.payment_intent
            : stripeSession.payment_intent?.id || "",
        walletBalanceBefore,
        walletBalanceAfter,
        createdAt: new Date(),
      });

      wallet.markModified("topups");
    }

    const snap = syncWalletBalances(wallet);
    await wallet.save();

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: alreadyCredited
          ? "Wallet topup already confirmed"
          : "Wallet topped up successfully",
        brandId,
        addedAmount: amount,
        ...snap,
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, 500, "CONFIRM_BRAND_WALLET_TOPUP_ERROR");
    const message = err instanceof Error ? err.message : "Internal error";

    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

// ======================================================================
// POST /brand-wallet/freeze-campaign
// Backward-compatible route: no campaign wallet exists anymore.
// Moves amount from brand walletBalance into brand escrowBalance.
// body: { brandId, amount, note?, campaignId?, influencerId? }
// ======================================================================
const freezeAmountForCampaign = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(req.body.brandId);
    const amount = roundMoney(Math.max(0, toNumber(req.body.amount, 0)));
    const note = clean(req.body.note || "Manual escrow move");

    if (!brandId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Valid brandId is required",
        requestId
      );
    }

    const wallet = await getOrCreateWallet(brandId);

    let snap;
    try {
      snap = moveAmountToEscrow(wallet, {
        amount,
        type: "manual_escrow",
        campaignId: req.body.campaignId,
        influencerId: req.body.influencerId,
        note,
      });
    } catch (err) {
      return ApiResponse.sendFail(
        res,
        err.status || HttpStatus.BAD_REQUEST,
        err.status === 402 ? EC("INSUFFICIENT_WALLET_BALANCE") : EC("VALIDATION_ERROR"),
        err.message,
        requestId,
        err.extra || {}
      );
    }

    await wallet.save();

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "Amount moved to escrow successfully",
        brandId,
        escrowAmount: amount,
        ...snap,
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, 500, "MOVE_AMOUNT_TO_ESCROW_ERROR");
    const message = err instanceof Error ? err.message : "Internal error";

    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

// ======================================================================
// POST /brand-wallet/allocate-to-influencer
// Backward-compatible route. Allocation is no longer campaign-scoped;
// use this only as another way to move available balance to escrow.
// ======================================================================
const allocateToInfluencer = async (req, res) => {
  return freezeAmountForCampaign(req, res);
};

// ======================================================================
// POST /brand-wallet/withdraw
// body: { brandId, amount, currency?, method?, transactionId?, note? }
// Withdraws from available walletBalance only. Escrow cannot be withdrawn.
// ======================================================================
const withdrawBrandWalletAmount = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(req.body.brandId);
    const amount = roundMoney(Math.max(0, toNumber(req.body.amount, 0)));
    const currency = clean(req.body.currency || "usd").toLowerCase();
    const method = clean(req.body.method || "manual");
    const transactionId = clean(req.body.transactionId);
    const note = clean(req.body.note);

    if (!brandId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Valid brandId is required",
        requestId
      );
    }

    if (!amount || amount <= 0) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "amount must be > 0",
        requestId
      );
    }

    const wallet = await BrandWalletModel.findOne({ brandId });

    if (!wallet) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.NOT_FOUND,
        EC("NOT_FOUND"),
        "Brand wallet not found",
        requestId
      );
    }

    const before = syncWalletBalances(wallet);

    if (amount > Number(before.walletBalance || 0)) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("INSUFFICIENT_WALLET_BALANCE"),
        "Withdraw amount cannot be greater than walletBalance",
        requestId,
        {
          walletBalance: before.walletBalance,
          escrowBalance: before.escrowBalance,
          frozenBalance: before.frozenBalance,
          needToAdd: roundMoney(amount - before.walletBalance),
        }
      );
    }

    const walletBalanceBefore = roundMoney(wallet.walletBalance);
    const walletBalanceAfter = roundMoney(walletBalanceBefore - amount);

    wallet.walletBalance = walletBalanceAfter;

    wallet.withdrawHistories = Array.isArray(wallet.withdrawHistories)
      ? wallet.withdrawHistories
      : [];

    wallet.withdrawHistories.push({
      brandId,
      amount,
      currency,
      status: "success",
      method,
      transactionId: transactionId || null,
      walletBalanceBefore,
      walletBalanceAfter,
      note,
      createdAt: new Date(),
    });

    wallet.markModified("withdrawHistories");

    const snap = syncWalletBalances(wallet);

    await wallet.save();

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "Wallet amount withdrawn successfully",
        brandId,
        withdrawnAmount: amount,
        ...snap,
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, 500, "WITHDRAW_BRAND_WALLET_AMOUNT_ERROR");
    const message = err instanceof Error ? err.message : "Internal error";

    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

// ======================================================================
// GET /brand-wallet/freeze-amount?brandId=xxx
// Backward-compatible name. Returns global escrow summary.
// ======================================================================
const getFrozenAmountForCampaign = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(
      typeof req.query.brandId === "string" ? req.query.brandId : ""
    );

    if (!brandId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "brandId is required",
        requestId
      );
    }

    const wallet = await BrandWalletModel.findOne({ brandId });

    if (!wallet) {
      return ApiResponse.sendOk(
        res,
        HttpStatus.OK,
        {
          brandId,
          walletBalance: 0,
          escrowBalance: 0,
          frozenBalance: 0,
          usableBalance: 0,
          totalFrozenAmount: 0,
          currentFrozenAmount: 0,
          availableToAllocate: 0,
        },
        requestId
      );
    }

    const snap = syncWalletBalances(wallet);
    await wallet.save();

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        brandId,
        ...snap,
        totalFrozenAmount: snap.escrowBalance,
        currentFrozenAmount: snap.escrowBalance,
        availableToAllocate: snap.walletBalance,
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, 500, "GET_ESCROW_AMOUNT_ERROR");
    const message = err instanceof Error ? err.message : "Internal error";

    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

// ======================================================================
// GET /brand-wallet/topupHistory?brandId=xxx
// ======================================================================
const getWalletTopup = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(
      typeof req.query.brandId === "string" ? req.query.brandId : ""
    );

    if (!brandId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Valid brandId is required",
        requestId
      );
    }

    const wallet = await BrandWalletModel.findOne({ brandId })
      .select("brandId topups")
      .lean();

    if (!wallet) {
      return ApiResponse.sendOk(
        res,
        HttpStatus.OK,
        {
          brandId,
          wallettopup: [],
        },
        requestId
      );
    }

    const wallettopup = Array.isArray(wallet.topups)
      ? [...wallet.topups].sort(
          (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
        )
      : [];

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        brandId,
        wallettopup,
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, 500, "GET_WALLET_TOPUP_ERROR");
    const message = err instanceof Error ? err.message : "Internal error";

    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

// ======================================================================
// GET /brand-wallet/history?brandId=xxx
// ======================================================================
const getBrandWalletHistory = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(
      typeof req.query.brandId === "string" ? req.query.brandId : ""
    );

    if (!brandId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Valid brandId is required",
        requestId
      );
    }

    const wallet = await BrandWalletModel.findOne({ brandId }).lean();

    if (!wallet) {
      return ApiResponse.sendOk(
        res,
        HttpStatus.OK,
        {
          brandId,
          topups: [],
          escrowHistories: [],
          withdrawHistories: [],
          transactions: [],
        },
        requestId
      );
    }

    const topups = Array.isArray(wallet.topups) ? wallet.topups : [];
    const escrowHistories = Array.isArray(wallet.escrowHistories)
      ? wallet.escrowHistories
      : [];
    const withdrawHistories = Array.isArray(wallet.withdrawHistories)
      ? wallet.withdrawHistories
      : [];

    const transactions = [
      ...topups.map((item) => ({
        type: "topup",
        amount: item.amount,
        currency: item.currency,
        status: item.status,
        createdAt: item.createdAt,
        raw: item,
      })),
      ...escrowHistories.map((item) => ({
        type: item.type || "escrow",
        amount: item.amount,
        campaignId: item.campaignId || "",
        influencerId: item.influencerId || "",
        milestoneId: item.milestoneId || "",
        milestoneHistoryId: item.milestoneHistoryId || "",
        createdAt: item.createdAt,
        raw: item,
      })),
      ...withdrawHistories.map((item) => ({
        type: "withdraw",
        amount: item.amount,
        currency: item.currency,
        status: item.status,
        createdAt: item.createdAt,
        raw: item,
      })),
    ].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        brandId,
        topups: [...topups].sort(
          (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
        ),
        escrowHistories: [...escrowHistories].sort(
          (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
        ),
        withdrawHistories: [...withdrawHistories].sort(
          (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
        ),
        transactions,
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, 500, "GET_BRAND_WALLET_HISTORY_ERROR");
    const message = err instanceof Error ? err.message : "Internal error";

    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

// Backward-compatible helper name. Older code may import calcFrozenAll.
const calcFrozenAll = (_freezes = [], wallet = null) =>
  wallet ? syncWalletBalances(wallet).escrowBalance : 0;

const syncCampaignFreeze = (freeze) => freeze || null;
const ensureCampaignFreeze = (_wallet, _brandId, _campaignId) => null;

module.exports = {
  getBrandWallet,
  topupBrandWallet,
  confirmBrandWalletTopup,

  freezeAmountForCampaign,
  allocateToInfluencer,
  withdrawBrandWalletAmount,

  getFrozenAmountForCampaign,
  getWalletTopup,
  getBrandWalletHistory,

  // Helpers used by milestone/contract flows if needed.
  roundMoney,
  syncWalletBalances,
  getOrCreateWallet,
  moveAmountToEscrow,
  refundAmountFromEscrow,
  releaseAmountFromEscrow,

  // Legacy helper exports.
  calcFrozenAll,
  syncCampaignFreeze,
  ensureCampaignFreeze,
};