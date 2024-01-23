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
  private _size: number = 0;

  readonly maxConcurrentOrders: number;

  readonly newQueue: OrderType[] = [];
  // readonly processQueue: ProcessOrder<OrderType>[] = [];
  readonly retryQueue: ProcessOrder<OrderType>[] = [];
  private _pendingCount: number = 0;

  readonly completedOrders: ReturnType[] = [];
  readonly skippedOrders: OrderType[] = [];
  readonly rejectedOrders: OrderType[] = [];

  get size(): number {
    return this._size;
  }

  get concurrentOrders(): number {
    return this._pendingCount + this.retryQueue.length;
  }

  constructor(
    readonly retryInterval: number,
    readonly maxTries: number,
    maxPendingOrders?: number,
  ) {
    this.maxConcurrentOrders = maxPendingOrders ?? Infinity;
  }

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

  // Queue management logic
  async init(): Promise<void> {}

  async addOrders(...orders: OrderType[]): Promise<void> {
    for (const order of orders) {
      this._size++;

      await this.onOrderInit(order);

      this.newQueue.push(order);
    }
  }

  async processOrders(): Promise<void> {
    const retryOrders = this.getOrdersToRetry();

    const retryOrdersPending = retryOrders.length > 0;
    const newOrdersPending = this.newQueue.length > 0;
    const capacityAvailable = this.concurrentOrders < this.maxConcurrentOrders;

    const processingRequired =
      retryOrdersPending || (newOrdersPending && capacityAvailable);

    if (!processingRequired) return;

    await this.onProcessOrders();

    // Process retries
    for (const order of retryOrders) {
      await this.processOrder(order);
    }

    // Process new orders as long as there is capacity
    let i;
    for (i = 0; i < this.newQueue.length; i++) {
      if (this.concurrentOrders >= this.maxConcurrentOrders) break;

      const newOrder: ProcessOrder<OrderType> = {
        order: this.newQueue[i],
        retryCount: 0,
        retryAtTimestamp: 0,
      };

      await this.processOrder(newOrder);
    }

    // Remove processed new orders from queue
    this.newQueue.splice(0, i);
  }

  private async processOrder(order: ProcessOrder<OrderType>): Promise<void> {
    try {
      const handleResult = await this.handleOrder(
        order.order,
        order.retryCount,
      );
      if (handleResult == null) {
        await this.handleOrderSuccess(order, null);
      } else {
        this._pendingCount++;
        Promise.resolve(handleResult.result).then(
          (result) => {
            void this.handleOrderSuccess(order, result).then(
              () => this._pendingCount--,
            );
          },
          (error) => {
            void this.handleOrderError(order, error, true).then(
              () => this._pendingCount--,
            );
          },
        );
      }
    } catch (error) {
      await this.handleOrderError(order, error, false);
    }
  }

  getOrdersToRetry(): ProcessOrder<OrderType>[] {
    // Get the number of elements to move from the `retry` to the `submit` queue. Note that the
    // `retry` queue elements are in chronological order.

    if (this.retryQueue.length == 0) return [];

    const nowTimestamp = Date.now();

    let i;
    for (i = 0; i < this.retryQueue.length; i++) {
      const retryOrder = this.retryQueue[i];
      if (retryOrder.retryAtTimestamp <= nowTimestamp) {
        retryOrder.retryCount++;
      } else {
        break;
      }
    }

    // Remove the elements to be retried from the `retry` queue
    return this.retryQueue.splice(0, i);
  }

  getFinishedOrders(): [ReturnType[], OrderType[], OrderType[]] {
    const completedOrders = [...this.completedOrders];
    this.completedOrders.length = 0;

    const skippedOrders = [...this.skippedOrders];
    this.skippedOrders.length = 0;

    const rejectedOrders = [...this.rejectedOrders];
    this.rejectedOrders.length = 0;

    const ordersRemoved =
      completedOrders.length + skippedOrders.length + rejectedOrders.length;
    this._size -= ordersRemoved;

    return [completedOrders, skippedOrders, rejectedOrders];
  }

  private async handleOrderSuccess(
    order: ProcessOrder<OrderType>,
    result: ReturnType | null,
  ): Promise<void> {
    await this.onOrderCompletion(order.order, true, null, order.retryCount);

    if (result != null) {
      this.completedOrders.push(result);
    } else {
      this.skippedOrders.push(order.order);
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
      this.rejectedOrders.push(order.order);
      return;
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
      this.skippedOrders.push(order.order);
    }
  }

  private addOrderToRetryQueue(order: ProcessOrder<OrderType>): void {
    // Move the order to the 'retry' queue
    order.retryAtTimestamp = Date.now() + this.retryInterval;
    this.retryQueue.push(order);
  }
}
