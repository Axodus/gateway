import Decimal from 'decimal.js-light';
import { BigNumber, Wallet } from 'ethers';
import { Token } from '@uniswap/sdk-core';
import {
  HttpException,
  LOAD_WALLET_ERROR_CODE,
  LOAD_WALLET_ERROR_MESSAGE,
  TOKEN_NOT_SUPPORTED_ERROR_CODE,
  TOKEN_NOT_SUPPORTED_ERROR_MESSAGE,
  PRICE_FAILED_ERROR_CODE,
  PRICE_FAILED_ERROR_MESSAGE,
  TRADE_FAILED_ERROR_CODE,
  TRADE_FAILED_ERROR_MESSAGE,
  SWAP_PRICE_EXCEEDS_LIMIT_PRICE_ERROR_CODE,
  SWAP_PRICE_EXCEEDS_LIMIT_PRICE_ERROR_MESSAGE,
  SWAP_PRICE_LOWER_THAN_LIMIT_PRICE_ERROR_CODE,
  SWAP_PRICE_LOWER_THAN_LIMIT_PRICE_ERROR_MESSAGE,
  UNKNOWN_ERROR_ERROR_CODE,
  UNKNOWN_ERROR_MESSAGE,
} from '../../services/error-handler';
import { TokenInfo } from '../../chains/ethereum/ethereum-base';
import { gasCostInEthString } from '../../services/base';
import {
  Ethereumish,
  ExpectedTrade,
  Uniswapish,
  Tokenish,
} from '../../services/common-interfaces';
import { logger } from '../../services/logger';
import {
  EstimateGasResponse,
  PriceRequest,
  PriceResponse,
  TradeRequest,
  TradeResponse,
} from '../connector.requests';
import { wrapResponse } from '../../services/response-wrapper';

export interface TradeInfo {
  baseToken: Tokenish;
  quoteToken: Tokenish;
  requestAmount: BigNumber;
  expectedTrade: ExpectedTrade;
}

export async function txWriteData(
  ethereumish: Ethereumish,
  address: string,
  maxFeePerGas?: string,
  maxPriorityFeePerGas?: string
): Promise<{
  wallet: Wallet;
  maxFeePerGasBigNumber: BigNumber | undefined;
  maxPriorityFeePerGasBigNumber: BigNumber | undefined;
}> {
  let maxFeePerGasBigNumber: BigNumber | undefined;
  if (maxFeePerGas) {
    maxFeePerGasBigNumber = BigNumber.from(maxFeePerGas);
  }
  let maxPriorityFeePerGasBigNumber: BigNumber | undefined;
  if (maxPriorityFeePerGas) {
    maxPriorityFeePerGasBigNumber = BigNumber.from(maxPriorityFeePerGas);
  }

  let wallet: Wallet;
  try {
    wallet = await ethereumish.getWallet(address);
  } catch (err) {
    logger.error(`Wallet ${address} not available.`);
    throw new HttpException(
      500,
      LOAD_WALLET_ERROR_MESSAGE + err,
      LOAD_WALLET_ERROR_CODE
    );
  }
  return { wallet, maxFeePerGasBigNumber, maxPriorityFeePerGasBigNumber };
}

export async function getTradeInfo(
  ethereumish: Ethereumish,
  uniswapish: Uniswapish,
  baseAsset: string,
  quoteAsset: string,
  baseAmount: Decimal,
  tradeSide: string,
  allowedSlippage?: string,
  poolId?: string,
): Promise<TradeInfo> {
  const baseToken: Tokenish = await getFullTokenFromSymbol(
    ethereumish,
    uniswapish,
    baseAsset
  );
  const quoteToken: Tokenish = await getFullTokenFromSymbol(
    ethereumish,
    uniswapish,
    quoteAsset
  );
  logger.info(
    `Converting amount for ${baseToken.symbol} (decimals: ${baseToken.decimals}): ` +
    `${baseAmount} -> ${baseAmount.toFixed(baseToken.decimals)} -> ${baseAmount.toFixed(baseToken.decimals).replace('.', '')}`
  );
  const requestAmount: BigNumber = BigNumber.from(
    baseAmount.toFixed(baseToken.decimals).replace('.', '')
  );

  let expectedTrade: ExpectedTrade;
  if (tradeSide === 'BUY') {
    expectedTrade = await uniswapish.estimateBuyTrade(
      quoteToken,
      baseToken,
      requestAmount,
      allowedSlippage,
      poolId
    );
  } else {
    expectedTrade = await uniswapish.estimateSellTrade(
      baseToken,
      quoteToken,
      requestAmount,
      allowedSlippage,
      poolId
    );
  }

  return {
    baseToken,
    quoteToken,
    requestAmount,
    expectedTrade,
  };
}

export async function price(
  ethereumish: Ethereumish,
  uniswapish: Uniswapish,
  req: PriceRequest
): Promise<PriceResponse> {
  const initTime = Date.now();
  let tradeInfo: TradeInfo;
  try {
    tradeInfo = await getTradeInfo(
      ethereumish,
      uniswapish,
      req.base,
      req.quote,
      new Decimal(req.amount),
      req.side,
      req.allowedSlippage,
      req.poolId,
    );
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

  const trade = tradeInfo.expectedTrade.trade;
  const expectedAmount = tradeInfo.expectedTrade.expectedAmount;

  const tradePrice =
    req.side === 'BUY' ? trade.executionPrice.invert() : trade.executionPrice;

  const gasLimitTransaction = ethereumish.gasLimitTransaction;
  const gasPrice = ethereumish.gasPrice;
  const gasLimitEstimate = uniswapish.gasLimitEstimate;
  return wrapResponse({
    network: ethereumish.chain,
    base: tradeInfo.baseToken.address,
    quote: tradeInfo.quoteToken.address,
    amount: new Decimal(req.amount).toFixed(tradeInfo.baseToken.decimals),
    rawAmount: tradeInfo.requestAmount.toString(),
    expectedAmount: expectedAmount.toSignificant(8),
    price: tradePrice.toSignificant(8),
    gasPrice: gasPrice,
    gasPriceToken: ethereumish.nativeTokenSymbol,
    gasLimit: gasLimitTransaction,
    gasCost: gasCostInEthString(gasPrice, gasLimitEstimate),
  }, initTime);
}

export async function trade(
  ethereumish: Ethereumish,
  uniswapish: Uniswapish,
  req: TradeRequest
): Promise<TradeResponse> {
  const initTime = Date.now();

  const limitPrice = req.limitPrice;
  const { wallet, maxFeePerGasBigNumber, maxPriorityFeePerGasBigNumber } =
    await txWriteData(
      ethereumish,
      req.address,
      req.maxFeePerGas,
      req.maxPriorityFeePerGas
    );

  let tradeInfo: TradeInfo;
  try {
    tradeInfo = await getTradeInfo(
      ethereumish,
      uniswapish,
      req.base,
      req.quote,
      new Decimal(req.amount),
      req.side,
      req.allowedSlippage,
      req.poolId,
    );
  } catch (e) {
    if (e instanceof Error) {
      logger.error(`Could not get trade info. ${e.message}`);
      throw new HttpException(
        500,
        TRADE_FAILED_ERROR_MESSAGE + e.message,
        TRADE_FAILED_ERROR_CODE
      );
    } else {
      logger.error('Unknown error trying to get trade info.');
      throw new HttpException(
        500,
        UNKNOWN_ERROR_MESSAGE,
        UNKNOWN_ERROR_ERROR_CODE
      );
    }
  }

  const gasPrice: number = ethereumish.gasPrice;
  const gasLimitTransaction: number = ethereumish.gasLimitTransaction;
  const gasLimitEstimate: number = uniswapish.gasLimitEstimate;

  if (req.side === 'BUY') {
    const price = tradeInfo.expectedTrade.trade.executionPrice.invert();
    if (
      limitPrice &&
      new Decimal(price.toFixed(8)).gt(new Decimal(limitPrice))
    ) {
      logger.error('Swap price exceeded limit price.');
      throw new HttpException(
        500,
        SWAP_PRICE_EXCEEDS_LIMIT_PRICE_ERROR_MESSAGE(
          price.toFixed(8),
          limitPrice
        ),
        SWAP_PRICE_EXCEEDS_LIMIT_PRICE_ERROR_CODE
      );
    }

    const tx = await uniswapish.executeTrade(
      wallet,
      tradeInfo.expectedTrade.trade,
      gasPrice,
      uniswapish.router,
      uniswapish.ttl,
      uniswapish.routerAbi,
      gasLimitTransaction,
      req.nonce,
      maxFeePerGasBigNumber,
      maxPriorityFeePerGasBigNumber,
      req.allowedSlippage,
      req.poolId,
    );

    if (tx.hash) {
      await ethereumish.txStorage.saveTx(
        ethereumish.chain,
        ethereumish.chainId,
        tx.hash,
        new Date(),
        ethereumish.gasPrice
      );
    }

    logger.info(
      `Trade has been executed, txHash is ${tx.hash}, nonce is ${tx.nonce}, gasPrice is ${gasPrice}.`
    );

    return wrapResponse({
      network: ethereumish.chain,
      base: tradeInfo.baseToken.address,
      quote: tradeInfo.quoteToken.address,
      amount: new Decimal(req.amount).toFixed(tradeInfo.baseToken.decimals),
      rawAmount: tradeInfo.requestAmount.toString(),
      expectedIn: tradeInfo.expectedTrade.expectedAmount.toSignificant(8),
      price: price.toSignificant(8),
      gasPrice: gasPrice,
      gasPriceToken: ethereumish.nativeTokenSymbol,
      gasLimit: gasLimitTransaction,
      gasCost: gasCostInEthString(gasPrice, gasLimitEstimate),
      nonce: tx.nonce,
      txHash: tx.hash,
    }, initTime);
  } else {
    const price = tradeInfo.expectedTrade.trade.executionPrice;
    logger.info(
      `Expected execution price is ${price.toFixed(6)}, ` +
        `limit price is ${limitPrice}.`
    );
    if (
      limitPrice &&
      new Decimal(price.toFixed(8)).lt(new Decimal(limitPrice))
    ) {
      logger.error('Swap price lower than limit price.');
      throw new HttpException(
        500,
        SWAP_PRICE_LOWER_THAN_LIMIT_PRICE_ERROR_MESSAGE(
          price.toFixed(8),
          limitPrice
        ),
        SWAP_PRICE_LOWER_THAN_LIMIT_PRICE_ERROR_CODE
      );
    }

    const tx = await uniswapish.executeTrade(
      wallet,
      tradeInfo.expectedTrade.trade,
      gasPrice,
      uniswapish.router,
      uniswapish.ttl,
      uniswapish.routerAbi,
      gasLimitTransaction,
      req.nonce,
      maxFeePerGasBigNumber,
      maxPriorityFeePerGasBigNumber,
      req.poolId,
    );

    logger.info(
      `Trade has been executed, txHash is ${tx.hash}, nonce is ${tx.nonce}, gasPrice is ${gasPrice}.`
    );

    return wrapResponse({
      network: ethereumish.chain,
      base: tradeInfo.baseToken.address,
      quote: tradeInfo.quoteToken.address,
      amount: new Decimal(req.amount).toFixed(tradeInfo.baseToken.decimals),
      rawAmount: tradeInfo.requestAmount.toString(),
      expectedOut: tradeInfo.expectedTrade.expectedAmount.toSignificant(8),
      price: price.toSignificant(8),
      gasPrice: gasPrice,
      gasPriceToken: ethereumish.nativeTokenSymbol,
      gasLimit: gasLimitTransaction,
      gasCost: gasCostInEthString(gasPrice, gasLimitEstimate),
      nonce: tx.nonce,
      txHash: tx.hash,
    }, initTime);
  }
}

export async function getFullTokenFromSymbol(
  ethereumish: Ethereumish,
  uniswapish: Uniswapish,
  tokenSymbol: string
): Promise<Token> {
  
  if (!ethereumish.ready()) {
    await ethereumish.init();
  }
  
  const tokenInfo: TokenInfo =
    ethereumish.getTokenBySymbol(tokenSymbol);
  
  const uniswapToken = new Token(
    tokenInfo.chainId,
    tokenInfo.address,
    tokenInfo.decimals,
    tokenInfo.symbol,
    tokenInfo.name
  );
  
  if (!uniswapToken)
    throw new HttpException(
      500,
      TOKEN_NOT_SUPPORTED_ERROR_MESSAGE + tokenSymbol,
      TOKEN_NOT_SUPPORTED_ERROR_CODE
    );
  return uniswapToken;
}

export async function estimateGas(
  ethereumish: Ethereumish,
  uniswapish: Uniswapish
): Promise<EstimateGasResponse> {
  const initTime = Date.now();
  const gasPrice: number = await ethereumish.estimateGasPrice();
  const gasLimitTransaction: number = ethereumish.gasLimitTransaction;
  const gasLimitEstimate: number = uniswapish.gasLimitEstimate;
  
  return wrapResponse({
    network: ethereumish.chain,
    gasPrice,
    gasPriceToken: ethereumish.nativeTokenSymbol,
    gasLimit: gasLimitTransaction,
    gasCost: gasCostInEthString(gasPrice, gasLimitEstimate),
  }, initTime);
}
