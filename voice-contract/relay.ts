/**
 * 豆包语音本地 relay（双向转发核心）。
 *
 * 为什么需要 relay：豆包旧 S2S 和新版 Duplex 都使用 WebSocket 鉴权头，
 * 而浏览器 WebSocket API 无法设置自定义头，所以浏览器不能直连豆包。
 * 本 relay 承载对应协议的鉴权头，浏览器只连本地 relay（无鉴权头）。
 *
 * 本模块是纯转发核心（注入两端 socket），同时保留文本帧和二进制帧类型。
 * 真实 ws 服务端接线见 relay-server.mjs。
 */
export type RelayData = string | Uint8Array

export interface RelayHandlers {
  onMessage(data: RelayData): void
  onClose(): void
}

export interface RelayEnd {
  send(data: RelayData): void
  close(): void
  setHandlers(handlers: RelayHandlers): void
}

export type UpstreamFactory = (url: string, headers: Record<string, string>) => RelayEnd

export class DoubaoRelay {
  private readonly upstreamFactory: UpstreamFactory
  private readonly upstreamUrl: string
  private readonly authHeaders: Record<string, string>

  constructor(upstreamFactory: UpstreamFactory, upstreamUrl: string, authHeaders: Record<string, string>) {
    this.upstreamFactory = upstreamFactory
    this.upstreamUrl = upstreamUrl
    this.authHeaders = authHeaders
  }

  /** 浏览器接入时调用：打开上游并建立双向转发。返回清理函数。 */
  attach(browser: RelayEnd): () => void {
    const upstream = this.upstreamFactory(this.upstreamUrl, this.authHeaders)
    let closed = false

    const closeBoth = (): void => {
      if (closed) return
      closed = true
      browser.close()
      upstream.close()
    }

    browser.setHandlers({
      onMessage: (data) => {
        if (!closed) upstream.send(data)
      },
      onClose: () => closeBoth(),
    })

    upstream.setHandlers({
      onMessage: (data) => {
        if (!closed) browser.send(data)
      },
      onClose: () => closeBoth(),
    })

    return closeBoth
  }
}
