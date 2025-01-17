import { TokenInfo } from '@solana/spl-token-registry';
import { Solana } from '../../chains/solana/solana';
import { Jupiter } from './jupiter';
import {
  PriceRequest,
  TradeRequest,
  TradeResponse,
  EstimateGasResponse,
} from '../connector.requests';
import {
  HttpException,
  SWAP_PRICE_EXCEEDS_LIMIT_PRICE_ERROR_CODE,
  SWAP_PRICE_EXCEEDS_LIMIT_PRICE_ERROR_MESSAGE,
  SWAP_PRICE_LOWER_THAN_LIMIT_PRICE_ERROR_CODE,
  SWAP_PRICE_LOWER_THAN_LIMIT_PRICE_ERROR_MESSAGE,
  PRICE_FAILED_ERROR_CODE,
  PRICE_FAILED_ERROR_MESSAGE,
  UNKNOWN_ERROR_ERROR_CODE,
  UNKNOWN_ERROR_MESSAGE,
  INSUFFICIENT_BASE_TOKEN_BALANCE_ERROR_CODE,
  INSUFFICIENT_BASE_TOKEN_BALANCE_ERROR_MESSAGE,
  INSUFFICIENT_QUOTE_TOKEN_BALANCE_ERROR_CODE,
  INSUFFICIENT_QUOTE_TOKEN_BALANCE_ERROR_MESSAGE,
} from '../../services/error-handler';
import { logger } from '../../services/logger';
import { Wallet } from '@coral-xyz/anchor';
import Decimal from 'decimal.js-light';
import { QuoteResponse } from '@jup-ag/api';
import { wrapResponse } from '../../services/response-wrapper';
import { DECIMAL_MULTIPLIER } from './jupiter';

export interface TradeInfo {
  baseToken: TokenInfo;
  quoteToken: TokenInfo;
  requestAmount: number;
  expectedPrice: number;
  expectedAmount: number;
  gasEstimate: EstimateGasResponse;
}

export async function getTradeInfo(
  solana: Solana,
  jupiter: Jupiter,
  baseAsset: string,
  quoteAsset: string,
  amount: number,
  tradeSide: string,
  allowedSlippage?: string,
): Promise<{ tradeInfo: TradeInfo; quote: QuoteResponse }> {
  const baseToken: TokenInfo = solana.getTokenForSymbol(baseAsset);
  const quoteToken: TokenInfo = solana.getTokenForSymbol(quoteAsset);
  const requestAmount = Math.floor(amount * DECIMAL_MULTIPLIER ** baseToken.decimals);

  const slippagePct = allowedSlippage ? Number(allowedSlippage) : jupiter.getSlippagePct();

  let quote: QuoteResponse;
  if (tradeSide === 'BUY') {
    quote = await jupiter.getQuote(
      quoteToken.symbol,
      baseToken.symbol,
      amount,
      slippagePct,
      false, // not restricting to direct routes
      false, // not using legacy transactions
      'ExactOut'
    );
  } else {
    quote = await jupiter.getQuote(
      baseToken.symbol,
      quoteToken.symbol,
      amount,
      slippagePct,
      false, // not restricting to direct routes
      false, // not using legacy transactions
      'ExactIn'
    );
  }
  
  const baseAmount = tradeSide === 'BUY'
    ? Number(quote.outAmount) / (10 ** baseToken.decimals)
    : Number(quote.inAmount) / (10 ** baseToken.decimals)
  const quoteAmount = tradeSide === 'BUY'
    ? Number(quote.inAmount) / (10 ** quoteToken.decimals)
    : Number(quote.outAmount) / (10 ** quoteToken.decimals)

  const expectedPrice = Number(quoteAmount) / Number(baseAmount);
  const expectedAmount = Number(quoteAmount);

  const gasEstimate = await estimateGas(solana, jupiter);

  return {
    tradeInfo: {
      baseToken,
      quoteToken,
      requestAmount,
      expectedPrice,
      expectedAmount,
      gasEstimate,
    },
    quote,
  };
}

export async function price(
  solana: Solana,
  jupiter: Jupiter,
  req: PriceRequest,
) {
  const initTime = Date.now();
  
  let tradeInfo: TradeInfo;
  let quote: QuoteResponse;
  try {
    const result = await getTradeInfo(
      solana,
      jupiter,
      req.base,
      req.quote,
      Number(req.amount),
      req.side,
      req.allowedSlippage,
    );
    tradeInfo = result.tradeInfo;
    quote = result.quote;
  } catch (e) {
    if (e instanceof Error) {
      throw new HttpException(
        500,
        PRICE_FAILED_ERROR_MESSAGE + e.message,
        PRICE_FAILED_ERROR_CODE
      );
    } else {
      throw new HttpException(
        500,
        UNKNOWN_ERROR_MESSAGE,
        UNKNOWN_ERROR_ERROR_CODE
      );
    }
  }

  const { baseToken, quoteToken, requestAmount, expectedPrice, expectedAmount, gasEstimate } = tradeInfo;

  return wrapResponse({
    network: solana.network,
    base: baseToken.address,
    quote: quoteToken.address,
    amount: new Decimal(req.amount).toFixed(baseToken.decimals),
    rawAmount: requestAmount.toString(),
    expectedAmount: expectedAmount.toString(),
    price: expectedPrice.toString(),
    gasPrice: gasEstimate.gasPrice,
    gasPriceToken: gasEstimate.gasPriceToken,
    gasLimit: gasEstimate.gasLimit,
    gasCost: gasEstimate.gasCost,
  }, initTime);
}

export async function trade(
  solana: Solana,
  jupiter: Jupiter,
  req: TradeRequest,
): Promise<TradeResponse> {
  const initTime = Date.now();
  
  const keypair = await solana.getWallet(req.address);
  const wallet = new Wallet(keypair as any);

  let tradeInfo: TradeInfo;
  let quote: QuoteResponse;
  try {
    const result = await getTradeInfo(
      solana,
      jupiter,
      req.base,
      req.quote,
      Number(req.amount),
      req.side,
      req.allowedSlippage,
    );
    tradeInfo = result.tradeInfo;
    quote = result.quote;
  } catch (e) {
    if (e instanceof Error) {
      throw new HttpException(
        500,
        PRICE_FAILED_ERROR_MESSAGE + e.message,
        PRICE_FAILED_ERROR_CODE
      );
    } else {
      throw new HttpException(
        500,
        UNKNOWN_ERROR_MESSAGE,
        UNKNOWN_ERROR_ERROR_CODE
      );
    }
  }
  
  const { baseToken, quoteToken, requestAmount, expectedPrice, expectedAmount, gasEstimate } = tradeInfo;

  // Check limit price conditions
  if (req.side === 'BUY') {
    if (req.limitPrice && new Decimal(expectedPrice).gt(new Decimal(req.limitPrice))) {
      logger.error('Swap price exceeded limit price.');
      throw new HttpException(
        500,
        SWAP_PRICE_EXCEEDS_LIMIT_PRICE_ERROR_MESSAGE(expectedPrice, req.limitPrice),
        SWAP_PRICE_EXCEEDS_LIMIT_PRICE_ERROR_CODE,
      );
    }
  } else {
    if (req.limitPrice && new Decimal(expectedPrice).lt(new Decimal(req.limitPrice))) {
      logger.error('Swap price lower than limit price.');
      throw new HttpException(
        500,
        SWAP_PRICE_LOWER_THAN_LIMIT_PRICE_ERROR_MESSAGE(expectedPrice, req.limitPrice),
        SWAP_PRICE_LOWER_THAN_LIMIT_PRICE_ERROR_CODE,
      );
    }
  }

  // Add balance check
  if (req.side === 'SELL') {
    const balance = await solana.getBalance(keypair, [baseToken.symbol]);
    if (new Decimal(balance[baseToken.symbol]).lt(new Decimal(req.amount))) {
      throw new HttpException(
        500,
        INSUFFICIENT_BASE_TOKEN_BALANCE_ERROR_MESSAGE,
        INSUFFICIENT_BASE_TOKEN_BALANCE_ERROR_CODE
      );
    }
  } else {
    const balance = await solana.getBalance(keypair, [quoteToken.symbol]);
    if (new Decimal(balance[quoteToken.symbol]).lt(new Decimal(expectedAmount))) {
      throw new HttpException(
        500,
        INSUFFICIENT_QUOTE_TOKEN_BALANCE_ERROR_MESSAGE,
        INSUFFICIENT_QUOTE_TOKEN_BALANCE_ERROR_CODE
      );
    }
  }

  // Execute swap with correct input/output tokens based on trade side
  const { 
    signature, 
    feeInLamports, 
    computeUnitLimit,
    priorityFeePrice 
  } = await jupiter.executeSwap(
    wallet,
    quote,
  );

  logger.info(`Swap confirmed: ${signature} - ${req.side} ${req.amount} ${baseToken.symbol} at ${expectedPrice} ${quoteToken.symbol}/${baseToken.symbol}`);

  const response = {
    network: solana.network,
    base: baseToken.address,
    quote: quoteToken.address,
    amount: new Decimal(req.amount).toFixed(baseToken.decimals),
    rawAmount: requestAmount.toString(),
    gasPrice: priorityFeePrice,
    gasPriceToken: gasEstimate.gasPriceToken,
    gasLimit: computeUnitLimit,
    gasCost: (feeInLamports / 1e9).toString(),
    txHash: signature,
    price: expectedPrice.toString(),
  };

  if (req.side === 'BUY') {
    return wrapResponse({
      ...response,
      expectedIn: expectedAmount.toString(),
    }, initTime);
  } else {
    return wrapResponse({
      ...response,
      expectedOut: expectedAmount.toString(),
    }, initTime);
  }
}

export async function estimateGas(
  solana: Solana,
  jupiter: Jupiter,
): Promise<EstimateGasResponse> {
  const initTime = Date.now();
  
  const priorityFeeInMicroLamports = await solana.estimatePriorityFees(
    solana.connectionPool.getNextConnection().rpcEndpoint
  );
  
  const gasCost = await solana.getGasPrice();

  return wrapResponse({
    network: solana.network,
    gasPrice: priorityFeeInMicroLamports,
    gasPriceToken: solana.nativeTokenSymbol,
    gasLimit: solana.config.defaultComputeUnits,
    gasCost: gasCost.toString(),
  }, initTime);
}
