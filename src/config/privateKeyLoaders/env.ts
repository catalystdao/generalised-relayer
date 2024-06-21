import { PrivateKeyLoader, PrivateKeyLoaderConfig } from "./privateKeyLoader";

export const PRIVATE_KEY_LOADER_TYPE_ENVIRONMENT_VARIABLE = 'env';
const DEFAULT_ENV_VARIABLE_NAME = 'RELAYER_PRIVATE_KEY';

export interface EnvPrivateKeyLoaderConfig extends PrivateKeyLoaderConfig {
    envVariableName?: string,
}

export class EnvPrivateKeyLoader extends PrivateKeyLoader {
    override loaderType: string = PRIVATE_KEY_LOADER_TYPE_ENVIRONMENT_VARIABLE;
    private readonly envVariableName: string;

    constructor(
        protected override readonly config: EnvPrivateKeyLoaderConfig,
    ) {
        super(config);

        this.envVariableName = config.envVariableName ?? DEFAULT_ENV_VARIABLE_NAME;
    }

    override async loadPrivateKey(): Promise<string> {
        const privateKey = process.env[this.envVariableName];
        
        if (privateKey == undefined) {
            throw new Error(
                `Failed to load privateKey from enviornment variable '${this.envVariableName}'.`,
            );
        }

        return privateKey;
    }
}

export default EnvPrivateKeyLoader;
