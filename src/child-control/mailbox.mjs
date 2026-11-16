// 移植元: openai/codex@b1573f1 codex-rs/core/src/agent/control/mailbox.rs（Apache-2.0）
// キュー型メールボックス（enqueue / take / watch / remove / close）を移植。
// 変更: tokio::watch の代わりに「未読あり」フラグの待受Promiseを使う。診断ゲージは除外。

export class Mailboxes {
  #boxes = new Map();
  #closed = false;

  #box(agent) {
    let box = this.#boxes.get(agent);
    if (!box) this.#boxes.set(agent, box = { pending: [], waiters: new Set() });
    return box;
  }
  #notify(box) {
    for (const wake of box.waiters) wake();
    box.waiters.clear();
  }

  /** 終了処理後は受け付けない（原典: "agent runtime is shutting down"）。 */
  enqueue(agent, messages) {
    if (this.#closed) throw new Error("子制御を終了中のため通知を受け付けません");
    const box = this.#box(agent);
    box.pending.push(...messages);
    this.#notify(box);
  }

  take(agent, accept = () => true) {
    const box = this.#boxes.get(agent);
    if (!box) return [];
    const taken = [], kept = [];
    for (const message of box.pending) (accept(message) ? taken : kept).push(message);
    box.pending = kept;
    return taken;
  }

  hasMail(agent, accept = () => true) {
    return (this.#boxes.get(agent)?.pending || []).some(accept);
  }

  /** 次の受信またはcloseで解決する。既に未読があれば即時解決。 */
  changed(agent, { signal } = {}) {
    if (this.#closed) return Promise.resolve(false);
    const box = this.#box(agent);
    return new Promise(resolve => {
      const wake = () => { signal?.removeEventListener("abort", stop); resolve(!this.#closed); };
      const stop = () => { box.waiters.delete(wake); resolve(false); };
      if (signal?.aborted) return resolve(false);
      box.waiters.add(wake);
      signal?.addEventListener("abort", stop, { once: true });
    });
  }

  remove(agent) { this.#boxes.delete(agent); }

  close() {
    this.#closed = true;
    for (const box of this.#boxes.values()) this.#notify(box);
  }
}
