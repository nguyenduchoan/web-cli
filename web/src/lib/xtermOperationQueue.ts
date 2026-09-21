export class XtermOperationQueue {
  private chain: Promise<void> = Promise.resolve();
  private generation: number;

  constructor(initialGeneration = 0) {
    this.generation = initialGeneration;
  }

  public invalidate(): number {
    this.generation += 1;
    return this.generation;
  }

  public getGeneration(): number {
    return this.generation;
  }

  public enqueue(
    generation: number,
    operation: () => void | Promise<void>
  ): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      if (generation !== this.generation) {
        return false;
      }
      await operation();
      return true;
    };

    const nextChain = this.chain.then(run, run);
    this.chain = nextChain.then(
      () => {},
      () => {}
    );
    return nextChain;
  }

  public barrier(): Promise<void> {
    return this.chain;
  }

  public reset(): void {
    this.generation += 1;
    this.chain = Promise.resolve();
  }
}
