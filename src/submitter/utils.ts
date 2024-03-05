import { TransactionReceipt } from '@ethersproject/providers';

// The following function provides a workaround to ethers5 not support setting a 'timeout' on
// transaction confirmation calls.
// NOTE: using ethers' 'waitForTransaction' is not a suitable alternative, as that function
// does not throw an error on transaction rejection.
export function addTransactionTimeout(
  txPromise: Promise<TransactionReceipt>,
  timeout: number,
): Promise<TransactionReceipt> {
  const timeoutPromise = new Promise<never>((resolve, reject) => {
    setTimeout(() => reject({ code: 'TIMEOUT' }), timeout);
  });
  return Promise.race([txPromise, timeoutPromise]);
}
