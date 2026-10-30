import dgram, { type Socket } from 'node:dgram'
import { networkInterfaces } from 'node:os'
import { z } from 'zod'

export const DISCOVERY_PORT = 45875
export const MULTICAST_ADDRESS = '239.255.43.21'
const packetSchema = z.object({
  app: z.literal('nearlink'),
  v: z.literal(1),
  id: z.string().regex(/^[a-f0-9]{64}$/),
  port: z.number().int().min(1).max(65535)
})

export function localAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((list) =>
    (list || [])
      .filter((i) => i.family === 'IPv4' && !i.internal && isLanAddress(i.address))
      .map((i) => i.address)
  )
}
export function isLanAddress(host: string): boolean {
  const n = host.split('.').map(Number)
  return (
    n.length === 4 &&
    n.every((v) => Number.isInteger(v) && v >= 0 && v <= 255) &&
    (n[0] === 10 ||
      n[0] === 127 ||
      (n[0] === 192 && n[1] === 168) ||
      (n[0] === 172 && n[1] >= 16 && n[1] <= 31) ||
      (n[0] === 169 && n[1] === 254))
  )
}
function broadcasts(): string[] {
  return Object.values(networkInterfaces()).flatMap((list) =>
    (list || [])
      .filter((i) => i.family === 'IPv4' && !i.internal && isLanAddress(i.address))
      .map((i) => {
        const ip = i.address.split('.').map(Number),
          mask = i.netmask.split('.').map(Number)
        return ip.map((n, idx) => n | (~mask[idx] & 255)).join('.')
      })
  )
}

export class Discovery {
  private socket?: Socket
  private timer?: ReturnType<typeof setInterval>
  constructor(
    private id: string,
    private port: number,
    private found: (id: string, host: string, port: number) => void,
    private failed: (error: string) => void
  ) {}
  start(): void {
    const socket = (this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true }))
    socket.on('error', (error) => this.failed(`自动发现暂不可用：${error.message}。仍可用地址连接。`))
    socket.on('message', (data, remote) => {
      if (data.length > 1024 || !isLanAddress(remote.address)) return
      try {
        const packet = packetSchema.parse(JSON.parse(data.toString('utf8')))
        if (packet.id !== this.id) this.found(packet.id, remote.address, packet.port)
      } catch {
        /* Ignore unrelated UDP traffic. */
      }
    })
    socket.bind(DISCOVERY_PORT, '0.0.0.0', () => {
      try {
        socket.setBroadcast(true)
        socket.setMulticastTTL(1)
        const addresses = localAddresses()
        if (!addresses.length) socket.addMembership(MULTICAST_ADDRESS)
        for (const address of addresses) {
          try {
            socket.addMembership(MULTICAST_ADDRESS, address)
          } catch {
            /* Some VPN interfaces cannot join. */
          }
        }
        this.announce()
        this.timer = setInterval(() => this.announce(), 3500)
        this.timer.unref()
      } catch (error) {
        this.failed(String(error))
      }
    })
  }
  announce(): void {
    if (!this.socket) return
    const packet = Buffer.from(JSON.stringify({ app: 'nearlink', v: 1, id: this.id, port: this.port }))
    for (const host of new Set([MULTICAST_ADDRESS, ...broadcasts()])) {
      try {
        this.socket.send(packet, DISCOVERY_PORT, host, () => {})
      } catch {
        /* Interface may be changing. */
      }
    }
  }
  stop(): void {
    clearInterval(this.timer)
    try {
      this.socket?.close()
    } catch {
      /* Already closed. */
    }
    this.socket = undefined
  }
}
