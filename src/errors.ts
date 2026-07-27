export class UnsupportedAbilityError extends Error {
  constructor(public readonly ability: string) {
    super(`QQ 官方机器人暂不支持该插件能力：${ability}`)
    this.name = 'UnsupportedAbilityError'
  }
}
