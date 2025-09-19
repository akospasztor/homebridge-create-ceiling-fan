/**
 * Simple mutex with a waiting queue.
 *
 * The mutex can be acquired by calling the `lock()` method which returns a
 * promise with a function pointing to the `unlock()` method. Afterwards the
 * caller can carry out the operations that are protected by the mutex. Then
 * the caller who holds the mutex must call the previously returned function
 * to unlock the mutex. If the caller fails to do so, the mutex will remain
 * locked.
 *
 * If the mutex is free to be locked, the locking happens immediately and the
 * caller can carry out its prorected operations. When the mutex is locked,
 * any subsequent caller that is trying to lock the mutex is forced to wait.
 * In this case , the actual acquire functionality is not executed but pushed
 * to the waiting queue. When the mutex is unlocked by the first caller, the
 * queue is processed and the mutex is locked immediately for the next in
 * waiting, i.e. resolving the promise by returning a function pointer (to the
 * mutex unlock method) for the caller.
 *
 * @example
 * // Create the mutex object
 * this.mutex = new Mutex();
 * ...
 * // Attempt to lock the mutex
 * // Note: the returned function pointer needs to be called to unlock the mutex
 * const releaseMutex = await this.mutex.lock();
 * // Do stuff protected by the mutex; this example just starts a timer with 3 seconds timeout
 * await new Promise((resolve) => setTimeout(resolve, 3000));
 * // Release the mutex
 * releaseMutex();
 */
export class Mutex {
  /** Track if the mutex is currently locked. */
  private isLocked: boolean = false;

  /** Queue for handling the lock requests when the mutex is already locked. */
  private waitingQueue: (() => void)[] = [];

  /**
   * Lock the mutex.
   *
   * If the mutex is free to be locked, the locking happens immediately and the
   * caller can carry out its prorected operations. When the mutex is locked,
   * any subsequent caller that is trying to lock the mutex is forced to wait.
   *
   * @return A promise that is resolved when the mutex is given to the caller.
   *         The returned promise (that is itself a function pointer) must be
   *         called to free (unlock) the mutex.
   */
  async lock(): Promise<() => void> {
    return new Promise(resolve => {
      // The actual locking function will be called either:
      // - immediately if the lock is free, or
      // - later from the queue when the lock becomes free
      const acquireLock = () => {
        this.isLocked = true;
        resolve(() => this.unlock());
      };

      // If the mutex is not yet locked, then lock it here and resolve the
      // promise by returning the unlock function to the caller. If it's
      // already locked, then do not resolve the promise and push the
      // actual locking function to the waiting queue. As soon as the current
      // lock is unlocked, the next in line waiting will be resolved.
      if (!this.isLocked) {
        acquireLock();
      } else {
        this.waitingQueue.push(acquireLock);
      }
    });
  }

  /** Unlock the mutex.
   *
   * This method is returned to the caller indicating that the mutex is locked.
   * After completing the operations protected by the mutex, the caller must
   * call this method to unlock (release) the mutex. If the caller fails to do
   * so, the mutex will remain locked.
   *
   * When the mutex is unlocked by the first caller and there are several
   * callers waiting to lock the mutex, the waiting queue is processed and the
   * mutex is locked immediately for the next caller in waiting.
   */
  private unlock() {
    // Check if there is a caller waiting in line for the mutex
    if (this.waitingQueue.length > 0) {
      // Pass the mutex to the next in line
      const nextPending = this.waitingQueue.shift();
      if (nextPending) {
        nextPending();
      }
    } else {
      // Release the lock if noone is waiting for the mutex
      this.isLocked = false;
    }
  }
}
