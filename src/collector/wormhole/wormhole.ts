import { ConfigService } from 'src/config/config.service';
import { CollectorModuleInterface } from '../collector.controller';
import { initiateRelayerEngineWorker } from './wormhole-engine';
import { initiateMessageSnifferWorkers } from './wormhole-message-sniffer';
import { initiateRecoveryWorkers } from './wormhole-recovery';
import { WormholeChainConfig, WormholeConfig } from './wormhole.types';
import { LoggerService } from 'src/logger/logger.service';
import { ChainConfig } from 'src/config/config.types';
import {
  DEFAULT_GETTER_RETRY_INTERVAL,
  DEFAULT_GETTER_PROCESSING_INTERVAL,
  DEFAULT_GETTER_MAX_BLOCKS,
} from 'src/getter/getter.service';
import { loadWormholeChainIdMap } from './wormhole.utils';

function loadWormholeConfig(
  configService: ConfigService,
  loggerService: LoggerService,
): WormholeConfig {
  // Get the global Wormhole config
  const globalWormholeConfig = configService.ambsConfig.get('wormhole');
  if (globalWormholeConfig == undefined) {
    throw Error(
      `Failed to load Wormhole module: 'wormhole' configuration not found.`,
    );
  }

  const wormholeChainConfigs = new Map<string, WormholeChainConfig>();
  configService.chainsConfig.forEach((chainConfig) => {
    const wormholeChainConfig = loadWormholeChainConfig(
      chainConfig,
      configService,
    );

    if (wormholeChainConfig != null) {
      wormholeChainConfigs.set(chainConfig.chainId, wormholeChainConfig);
      loggerService.info(
        { chainId: chainConfig.chainId, wormholeChainConfig },
        `Wormhole configuration for chain found.`,
      );
    } else {
      loggerService.info(
        { chainId: chainConfig.chainId },
        `Wormhole configuration for chain not found or incomplete.`,
      );
    }
  });

  const wormholeChainIdMap = loadWormholeChainIdMap(wormholeChainConfigs);

  if (process.env.REDIS_PORT == undefined) {
    throw new Error(`Failed to load environment variable 'REDIS_PORT'`)
  }
  const redisPort = parseInt(process.env.REDIS_PORT);

  if (process.env.SPY_PORT == undefined) {
    throw new Error(`Failed to load environment variable 'SPY_PORT'`)
  }
  const spyPort = parseInt(process.env.SPY_PORT);

  const redisDBIndex = process.env.REDIS_WORMHOLE_DB_INDEX != undefined
    ? parseInt(process.env.REDIS_WORMHOLE_DB_INDEX)
    : undefined;

  return {
    isTestnet: globalWormholeConfig.globalProperties['isTestnet'],
    redisHost: process.env.REDIS_HOST,
    redisPort,
    redisDBIndex,
    spyHost: process.env.SPY_HOST,
    spyPort,
    wormholeChainConfigs,
    wormholeChainIdMap,
    loggerOptions: loggerService.loggerOptions,
  };
}

function loadWormholeChainConfig(
  chainConfig: ChainConfig,
  configService: ConfigService,
): WormholeChainConfig | null {
  const chainId = chainConfig.chainId;

  const wormholeChainId: number | undefined = configService.getAMBConfig(
    'wormhole',
    'wormholeChainId',
    chainId,
  );

  const wormholeAddress: string | undefined = configService.getAMBConfig(
    'wormhole',
    'bridgeAddress',
    chainId,
  );

  const incentivesAddress: string | undefined = configService.getAMBConfig(
    'wormhole',
    'incentivesAddress',
    chainId,
  );

  if (
    wormholeChainId == undefined ||
    wormholeAddress == undefined ||
    incentivesAddress == undefined
  ) {
    return null;
  }

  const rpc = chainConfig.rpc;
  const resolver = chainConfig.resolver;

  const startingBlock = chainConfig.startingBlock;
  const stoppingBlock = chainConfig.stoppingBlock;

  const globalConfig = configService.globalConfig;
  const retryInterval =
    chainConfig.getter.retryInterval ??
    globalConfig.getter.retryInterval ??
    DEFAULT_GETTER_RETRY_INTERVAL;
  const processingInterval =
    chainConfig.getter.processingInterval ??
    globalConfig.getter.processingInterval ??
    DEFAULT_GETTER_PROCESSING_INTERVAL;
  const maxBlocks =
    chainConfig.getter.maxBlocks ??
    globalConfig.getter.maxBlocks ??
    DEFAULT_GETTER_MAX_BLOCKS;

  return {
    chainId,
    rpc,
    resolver,
    startingBlock,
    stoppingBlock,
    retryInterval,
    processingInterval,
    maxBlocks,
    wormholeChainId,
    incentivesAddress,
    wormholeAddress,
  };
}

export default async (moduleInterface: CollectorModuleInterface) => {
  const { configService, monitorService, loggerService } = moduleInterface;

  const wormholeConfig = loadWormholeConfig(configService, loggerService);

  initiateRelayerEngineWorker(wormholeConfig, loggerService);

  await initiateMessageSnifferWorkers(wormholeConfig, monitorService, loggerService);

  initiateRecoveryWorkers(wormholeConfig, loggerService);
};
