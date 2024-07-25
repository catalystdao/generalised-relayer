import { BYTES_32_HEX_EXPR } from "../config.schema";

export const PRIVATE_KEY_LOADER_TYPE_BASE = 'base';

const DEFAULT_PRIVATE_KEY_LOADER = 'env';

export interface PrivateKeyLoaderConfig {
}

export function loadPrivateKeyLoader(
    loader: string | null,
    config: PrivateKeyLoaderConfig
): BasePrivateKeyLoader {

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const module = require(`./${loader ?? DEFAULT_PRIVATE_KEY_LOADER}`);
    const loaderClass: typeof BasePrivateKeyLoader = module.default;

    return new loaderClass(
        config,
    )
}

export abstract class PrivateKeyLoader {
    abstract readonly loaderType: string;

    constructor(
        protected readonly config: PrivateKeyLoaderConfig,
    ) {}

    abstract loadPrivateKey(): Promise<string>;

    async load(): Promise<string> {
        const privateKey = await this.loadPrivateKey();

        if (!new RegExp(BYTES_32_HEX_EXPR).test(privateKey)) {
            throw new Error('Invalid loaded privateKey format.')
        }

        return privateKey;
    }
}


// ! 'BasePrivateKeyLoader' should only be used as a type.
export class BasePrivateKeyLoader extends PrivateKeyLoader {
    override loaderType: string = PRIVATE_KEY_LOADER_TYPE_BASE;
    override loadPrivateKey(): Promise<string> {
        throw new Error("Method not implemented.");
    }
}
