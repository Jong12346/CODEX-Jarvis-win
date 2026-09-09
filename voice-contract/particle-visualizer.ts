export type ParticleVoiceMode = 'idle' | 'connecting' | 'listening' | 'muted' | 'speaking' | 'closing' | 'error'

type Particle = {
  fromX: number
  fromY: number
  targetX: number
  targetY: number
  size: number
  phase: number
  delay: number
  curve: number
  amber: boolean
}

const FORMATION_MS = 1800

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function ease(value: number): number {
  const clamped = clamp(value)
  return clamped * clamped * (3 - 2 * clamped)
}

export class JarvisParticleVisualizer {
  private readonly context: CanvasRenderingContext2D
  private readonly resizeObserver: ResizeObserver
  private particles: Particle[] = []
  private mode: ParticleVoiceMode = 'idle'
  private targetLevel = 0
  private level = 0
  private formationStartedAt = -10000
  private frame = 0
  private width = 1
  private height = 1
  private targetBounds = { left: 0, top: 0, width: 1, height: 1 }

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly image: HTMLImageElement,
    private readonly container: HTMLElement,
  ) {
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas 2D is unavailable')
    this.context = context
    this.resizeObserver = new ResizeObserver(() => this.prepare())
    this.resizeObserver.observe(container)
    if (image.complete && image.naturalWidth) this.prepare()
    else image.addEventListener('load', () => this.prepare(), { once: true })
    this.frame = requestAnimationFrame((now) => this.draw(now))
  }

  setMode(mode: ParticleVoiceMode): void {
    if (mode === this.mode) return
    this.mode = mode
    this.container.dataset.mode = mode
    if (mode === 'connecting') this.startFormation()
  }

  setLevel(level: number): void {
    this.targetLevel = clamp(level)
  }

  destroy(): void {
    cancelAnimationFrame(this.frame)
    this.resizeObserver.disconnect()
  }

  private prepare(): void {
    if (!this.image.naturalWidth) return
    const containerBounds = this.container.getBoundingClientRect()
    const imageBounds = this.image.getBoundingClientRect()
    this.width = Math.max(1, Math.round(containerBounds.width))
    this.height = Math.max(1, Math.round(containerBounds.height))
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1)
    this.canvas.width = Math.round(this.width * pixelRatio)
    this.canvas.height = Math.round(this.height * pixelRatio)
    this.canvas.style.width = `${this.width}px`
    this.canvas.style.height = `${this.height}px`
    this.context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)

    const left = imageBounds.left - containerBounds.left
    const top = imageBounds.top - containerBounds.top
    this.targetBounds = { left, top, width: imageBounds.width, height: imageBounds.height }
    const sample = document.createElement('canvas')
    sample.width = this.width
    sample.height = this.height
    const sampleContext = sample.getContext('2d', { willReadFrequently: true })
    if (!sampleContext) return
    sampleContext.drawImage(this.image, left, top, imageBounds.width, imageBounds.height)
    const pixels = sampleContext.getImageData(0, 0, this.width, this.height).data
    const particles: Particle[] = []
    for (let y = 0; y < this.height; y += 6) {
      for (let x = 0; x < this.width; x += 6) {
        if (pixels[(y * this.width + x) * 4 + 3] < 56 || Math.random() > 0.72) continue
        const particle: Particle = {
          fromX: 0,
          fromY: 0,
          targetX: x + (Math.random() - 0.5) * 4,
          targetY: y + (Math.random() - 0.5) * 4,
          size: Math.random() > 0.96 ? 2.2 : 0.45 + Math.random() * 1.25,
          phase: Math.random() * Math.PI * 2,
          delay: Math.random() * 0.25,
          curve: (Math.random() - 0.5) * 150,
          amber: Math.random() < 0.12,
        }
        this.scatter(particle)
        particles.push(particle)
      }
    }
    this.particles = particles
  }

  private scatter(particle: Particle): void {
    const edge = Math.floor(Math.random() * 4)
    if (edge === 0 || edge === 1) {
      particle.fromX = edge === 0 ? 0 : this.width
      particle.fromY = Math.random() * this.height
    } else {
      particle.fromX = Math.random() * this.width
      particle.fromY = edge === 2 ? 0 : this.height
    }
  }

  private startFormation(): void {
    if (!this.particles.length) this.prepare()
    this.formationStartedAt = performance.now()
    for (const particle of this.particles) this.scatter(particle)
  }

  private position(particle: Particle, progress: number): { x: number; y: number } {
    const eased = ease(progress)
    const deltaX = particle.targetX - particle.fromX
    const deltaY = particle.targetY - particle.fromY
    const distance = Math.max(1, Math.hypot(deltaX, deltaY))
    const bend = Math.sin(eased * Math.PI) * particle.curve
    return {
      x: particle.fromX + deltaX * eased - deltaY / distance * bend,
      y: particle.fromY + deltaY * eased + deltaX / distance * bend,
    }
  }

  private drawEnergy(now: number, progress: number): void {
    const centerX = this.targetBounds.left + this.targetBounds.width / 2
    const centerY = this.targetBounds.top + this.targetBounds.height / 2
    const intensity = Math.sin(clamp(progress) * Math.PI)
    const outer = Math.max(this.width, this.height) * 0.48
    const target = Math.max(this.targetBounds.width, this.targetBounds.height) * 0.42
    const radius = outer + (target - outer) * ease(progress)
    this.context.save()
    this.context.globalCompositeOperation = 'lighter'
    this.context.translate(centerX, centerY)
    this.context.scale(1, 0.64)
    for (let index = 0; index < 3; index += 1) {
      this.context.beginPath()
      this.context.setLineDash([12 + index * 5, 28 + index * 6])
      this.context.lineDashOffset = (index % 2 ? 1 : -1) * now / (13 + index * 3)
      this.context.arc(0, 0, radius + index * 24, 0, Math.PI * 2)
      this.context.strokeStyle = index === 1
        ? `rgba(255,155,47,${intensity * 0.34})`
        : `rgba(94,233,255,${intensity * (0.52 - index * 0.1)})`
      this.context.lineWidth = index === 0 ? 1.5 : 0.7
      this.context.stroke()
    }
    this.context.restore()
  }

  private draw(now: number): void {
    this.level += (this.targetLevel - this.level) * (this.targetLevel > this.level ? 0.24 : 0.075)
    this.targetLevel *= 0.94
    this.context.clearRect(0, 0, this.width, this.height)
    const rawProgress = (now - this.formationStartedAt) / FORMATION_MS
    const forming = rawProgress >= 0 && rawProgress < 1.08
    const baseAlpha = this.mode === 'speaking'
      ? 0.18 + this.level * 0.55
      : this.mode === 'listening'
        ? 0.09 + this.level * 0.34
        : this.mode === 'error'
          ? 0.15
          : 0.055

    this.context.globalCompositeOperation = 'lighter'
    for (const particle of this.particles) {
      const localRaw = forming ? (rawProgress - particle.delay) / (1 - particle.delay) : 1
      const progress = clamp(localRaw)
      const point = this.position(particle, progress)
      const previous = this.position(particle, Math.max(0, progress - 0.05))
      const drift = forming ? 0 : Math.sin(now / 620 + particle.phase) * (1 + this.level * 4)
      const x = point.x + drift
      const y = point.y + Math.cos(now / 760 + particle.phase) * (forming ? 0 : 1.2)
      const alpha = forming ? (localRaw < 0 ? 0.08 : 0.3 + Math.sin(progress * Math.PI) * 0.68) : baseAlpha
      const color = this.mode === 'error'
        ? '255,102,125'
        : this.mode === 'muted' || particle.amber
          ? '255,177,79'
          : '94,233,255'
      if (forming) {
        this.context.beginPath()
        this.context.moveTo(previous.x, previous.y)
        this.context.lineTo(x, y)
        this.context.strokeStyle = `rgba(${color},${alpha * 0.34})`
        this.context.lineWidth = 0.7
        this.context.stroke()
      }
      this.context.beginPath()
      this.context.arc(x, y, particle.size * (1 + this.level * 0.8), 0, Math.PI * 2)
      this.context.fillStyle = `rgba(${color},${alpha})`
      this.context.fill()
    }
    if (forming) this.drawEnergy(now, rawProgress)
    this.context.globalCompositeOperation = 'source-over'
    this.frame = requestAnimationFrame((next) => this.draw(next))
  }
}
