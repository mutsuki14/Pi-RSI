import type { Usage } from '@earendil-works/pi-ai'

/**
 * Token and cost totals of nested role sessions. pi asks tools that make
 * nested model calls to report their usage in the tool result, so session
 * totals stay accurate.
 */
export class UsageMeter {
  #usage: Usage = UsageMeter.zero()
  #calls = 0

  static zero(): Usage {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  }

  add(usage: Usage | undefined): void {
    if (!usage) return
    const total = this.#usage
    total.input += usage.input ?? 0
    total.output += usage.output ?? 0
    total.cacheRead += usage.cacheRead ?? 0
    total.cacheWrite += usage.cacheWrite ?? 0
    total.totalTokens += usage.totalTokens ?? 0
    total.cost.input += usage.cost?.input ?? 0
    total.cost.output += usage.cost?.output ?? 0
    total.cost.cacheRead += usage.cost?.cacheRead ?? 0
    total.cost.cacheWrite += usage.cost?.cacheWrite ?? 0
    total.cost.total += usage.cost?.total ?? 0
    this.#calls++
  }

  get calls(): number {
    return this.#calls
  }

  /** A copy of the totals, or undefined when no nested model call happened. */
  snapshot(): Usage | undefined {
    return this.#calls === 0 ? undefined : structuredClone(this.#usage)
  }

  summary(): string {
    const usage = this.#usage
    const cost = usage.cost.total > 0 ? `, $${usage.cost.total.toFixed(4)}` : ''
    return `${this.#calls} role model calls, ${usage.totalTokens} tokens${cost}`
  }
}
