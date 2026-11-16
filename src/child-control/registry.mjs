// 移植元: openai/codex@b1573f1 codex-rs/core/src/agent/registry.rs（Apache-2.0）
// AgentRegistry の生成枠予約（reserve_spawn_slot / try_increment_spawned）、確定（SpawnReservation::commit）、
// 未確定予約の解放（Drop）、解除（release_spawned_thread）、一覧（live_agents）を移植。
// 除外: AgentPath木・ニックネーム・evicted environments（residencyは移植対象外）。
// 変更: RustのDropはJSに無いため、未確定予約は abandon() を明示呼出しする（spawn-guardが必ず呼ぶ）。

export class AgentLimitReached extends Error {
  constructor(maxThreads) {
    super(`同時に保持できる子セッションの上限 (${maxThreads}) に達しました。不要な会話をclose_conversationで閉じてください`);
    this.maxThreads = maxThreads;
  }
}

export class AgentRegistry {
  #agents = new Map();
  #total = 0;

  get total() { return this.#total; }

  /** 上限を超える場合は予約せず失敗する。maxThreads未指定は上限なし（原典と同じ）。 */
  reserveSpawnSlot(maxThreads) {
    if (maxThreads !== undefined && this.#total >= maxThreads) throw new AgentLimitReached(maxThreads);
    this.#total++;
    return new SpawnReservation(this);
  }

  /** 登録済みの子だけ件数を減らす。未登録IDの二重解除で件数を壊さない。 */
  releaseSpawnedThread(agentId) {
    if (this.#agents.delete(agentId)) this.#total--;
  }

  metadata(agentId) { return this.#agents.get(agentId) ?? null; }

  liveAgents() { return [...this.#agents.values()].map(m => ({ ...m })); }

  _register(metadata) { this.#agents.set(metadata.agentId, { ...metadata }); }
  _abandon() { this.#total--; }
}

export class SpawnReservation {
  #registry;
  #active = true;
  constructor(registry) { this.#registry = registry; }
  get active() { return this.#active; }
  commit(metadata) {
    if (!this.#active) throw new Error("生成予約は既に確定または破棄されています");
    this.#active = false;
    this.#registry._register(metadata);
  }
  /** 原典のDrop相当。確定前に失敗した生成の枠を返す。確定後は何もしない。 */
  abandon() {
    if (!this.#active) return;
    this.#active = false;
    this.#registry._abandon();
  }
}
