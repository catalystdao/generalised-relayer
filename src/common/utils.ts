import { ethers } from "ethers6";

export const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * Adds 0x to the begining of an address
 * @param address address string
 * @returns The string with 0x
 */
export const add0X = (address: string): string => `0x${address}`;

export const convertHexToDecimal = (hex: string) => BigInt(hex).toString();

export const tryErrorToString = (error: any): string | undefined => {
    if (error == undefined) {
        return undefined;
    }
    if (typeof error == "string") {
        return error;
    }
    try {
        return error.toString();
    } catch {
        return 'Unable to stringify error.';
    }
}
export function paddedTo0xAddress(paddedAddress: string): string {
    const normalAddress = '0x' + paddedAddress.slice(-40);
    return ethers.getAddress(normalAddress);
};