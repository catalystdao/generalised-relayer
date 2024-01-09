import { CollectorModuleInterface } from '../collector.controller';

export default (moduleInterface: CollectorModuleInterface) => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { configService, loggerService } = moduleInterface;
};
