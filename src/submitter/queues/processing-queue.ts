//TODO replace this file with the following package once made public https://github.com/catalystdao/ProcessingQueue
export interface ProcessOrder<T> {
  order: T;
  retryCount: number;
  retryAtTimestamp: number;
}

export interface HandleOrderResult<T> {
  result: T | Promise<T> | null;
}

export abstract class ProcessingQueue<OrderType, ReturnType = OrderType> {
  private _processingCount: number = 0;

  readonly ordersQueue: ProcessOrder<OrderType>[] = [];
  readonly completedQueue: ReturnType[] = [];
  readonly retryQueue: ProcessOrder<OrderType>[] = [];

  get size(): number {
    return this._processingCount + this.completedQueue.length;
  }

  constructor(
    readonly retryInterval: number,
    readonly maxTries: number,
  ) {}

  // Custom logic implementation
  protected abstract handleOrder(
    order: OrderType,
    retryCount: number,
  ): Promise<HandleOrderResult<ReturnType> | null>;

  protected abstract handleFailedOrder(
    order: OrderType,
    retryCount: number,
    error: any,
    errorOnPending: boolean,
  ): Promise<boolean>;

  // Hooks
  protected async onOrderInit(_order: OrderType): Promise<void> {}

  protected async onOrderCompletion(
    _order: OrderType,
    _success: boolean,
    _result: ReturnType | null,
    _retryCount: number,
  ): Promise<void> {}

  protected async onProcessOrders(): Promise<void> {}

  protected async onProcessRetries(): Promise<void> {}

  // Queue management logic
  async init(): Promise<void> {}

  async addOrders(...orders: OrderType[]): Promise<void> {
    for (const order of orders) {
      this._processingCount++;

      await this.onOrderInit(order);

      this.ordersQueue.push({
        order,
        retryCount: 0,
        retryAtTimestamp: 0,
      });
    }
  }

  async processOrders(): Promise<void> {
    if (this.ordersQueue.length > 0) await this.onProcessOrders();

    for (const order of this.ordersQueue) {
      try {
        const handleResult = await this.handleOrder(
          order.order,
          order.retryCount,
        );
        if (handleResult == null) {
          void this.handleOrderSuccess(order, null);
        } else {
          Promise.resolve(handleResult.result).then(
            (result) => void this.handleOrderSuccess(order, result),
            (error) => void this.handleOrderError(order, error, true),
          );
        }
      } catch (error) {
        void this.handleOrderError(order, error, false);
      }
    }

    // Clear the 'orders' queue
    this.ordersQueue.length = 0;
  }

  async processRetries(): Promise<void> {
    // Get the number of elements to move from the `retry` to the `submit` queue. Note that the
    // `retry` queue elements are in chronological order.

    if (this.retryQueue.length == 0) return;

    await this.onProcessRetries();

    const nowTimestamp = Date.now();

    let i;
    for (i = 0; i < this.retryQueue.length; i++) {
      const retryOrder = this.retryQueue[i];
      if (retryOrder.retryAtTimestamp <= nowTimestamp) {
        retryOrder.retryCount++;
        this.ordersQueue.push(retryOrder);
      } else {
        break;
      }
    }

    // Remove the elements to be retried from the `retry` queue
    this.retryQueue.splice(0, i);
  }

  getCompletedOrders(): ReturnType[] {
    const completedOrders = [...this.completedQueue];
    this.completedQueue.length = 0;

    return completedOrders;
  }

  private async handleOrderSuccess(
    order: ProcessOrder<OrderType>,
    result: ReturnType | null,
  ): Promise<void> {
    await this.onOrderCompletion(order.order, true, null, order.retryCount);
    this._processingCount--;

    if (result != null) {
      this.completedQueue.push(result);
    }
  }

  private async handleOrderError(
    order: ProcessOrder<OrderType>,
    error: any,
    errorOnPending: boolean,
  ): Promise<void> {
    const maxTriesReached = order.retryCount >= this.maxTries - 1;
    if (maxTriesReached) {
      await this.onOrderCompletion(
        order.order,
        false, // Set success to false
        null,
        order.retryCount,
      );
      this._processingCount--;
    }

    const retryOrder = await this.handleFailedOrder(
      order.order,
      order.retryCount,
      error,
      errorOnPending,
    );
    if (retryOrder) {
      this.addOrderToRetryQueue(order);
    } else {
      await this.onOrderCompletion(
        order.order,
        false, // Set success to false
        null,
        order.retryCount,
      );
      this._processingCount--;
    }
  }

  private addOrderToRetryQueue(order: ProcessOrder<OrderType>): void {
    // Move the order to the 'retry' queue
    order.retryAtTimestamp = Date.now() + this.retryInterval;
    this.retryQueue.push(order);
  }
}
