// 移植元: openai/codex@b1573f1 codex-rs/core/src/agent/control/watch.rs（Apache-2.0）
// subscribe_status: 購読時点のスナップショットを最初に返し、その後の変化は合成（coalesce）して返す。
// チャネルが閉じたらストリームを終える。変更: tokio::watch → 版番号付きの値チャネル。

export class StatusChannel {
  #value;
  #version = 0;
  #closed = false;
  #waiters = new Set();
  constructor(initial) { this.#value = initial; }
  get value() { return this.#value; }
  get closed() { return this.#closed; }
  set(value) {
    if (this.#closed) return;
    this.#value = value;
    this.#version++;
    this.#wake();
  }
  close() { this.#closed = true; this.#wake(); }
  #wake() { for (const wake of this.#waiters) wake(); this.#waiters.clear(); }

  /** 初期値→（途中の変化を合成した）最新値の順に返す非同期イテレーター。 */
  async *subscribe({ signal } = {}) {
    let seen = this.#version;
    yield this.#value;
    while (!signal?.aborted) {
      if (this.#version === seen) {
        if (this.#closed) return;
        const alive = await new Promise(resolve => {
          const wake = () => { signal?.removeEventListener("abort", stop); resolve(true); };
          const stop = () => { this.#waiters.delete(wake); resolve(false); };
          this.#waiters.add(wake);
          signal?.addEventListener("abort", stop, { once: true });
        });
        if (!alive) return;
        if (this.#version === seen) continue;
      }
      seen = this.#version;
      yield this.#value;
    }
  }
}
