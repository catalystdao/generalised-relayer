import { ConfigService } from 'src/config/config.service';
import { CollectorModuleInterface } from '../collector.controller';
import { initiateRelayerEngineWorker } from './wormhole-engine';
import { initiateMessageSnifferWorkers } from './wormhole-message-sniffer';
import { initiateRecoveryWorkers } from './wormhole-recovery';
import { WormholeChainConfig, WormholeConfig } from './wormhole.types';
import { LoggerService } from 'src/logger/logger.service';
import { ChainConfig } from 'src/config/config.types';
import {
  DEFAULT_GETTER_BLOCK_DELAY,
  DEFAULT_GETTER_INTERVAL,
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

  return {
    isTestnet: globalWormholeConfig.globalProperties['isTestnet'],
    useDocker: process.env.USE_DOCKER == 'true', //TODO this should be loaded from the configService
    spyPort: process.env.SPY_PORT ?? '', //TODO this should be loaded from the configService
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

  const startingBlock = chainConfig.startingBlock;
  const stoppingBlock = chainConfig.stoppingBlock;

  const globalConfig = configService.globalConfig;
  const blockDelay =
    chainConfig.blockDelay ??
    globalConfig.blockDelay ??
    DEFAULT_GETTER_BLOCK_DELAY;
  const interval =
    chainConfig.getter.interval ??
    globalConfig.getter.interval ??
    DEFAULT_GETTER_INTERVAL;
  const maxBlocks =
    chainConfig.getter.maxBlocks ??
    globalConfig.getter.maxBlocks ??
    DEFAULT_GETTER_MAX_BLOCKS;

  return {
    chainId,
    rpc,
    startingBlock,
    stoppingBlock,
    blockDelay,
    interval,
    maxBlocks,
    wormholeChainId,
    incentivesAddress,
    wormholeAddress,
  };
}

export default (moduleInterface: CollectorModuleInterface) => {
  const { configService, loggerService } = moduleInterface;

  const wormholeConfig = loadWormholeConfig(configService, loggerService);

  initiateRelayerEngineWorker(wormholeConfig, loggerService);

  initiateMessageSnifferWorkers(wormholeConfig, loggerService);

  initiateRecoveryWorkers(wormholeConfig, loggerService);
};
