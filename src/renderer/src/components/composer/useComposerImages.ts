import { useCallback, useEffect, useRef, useState } from 'react'

export interface PastedImage {
  id: string
  mimeType: string
  data: string
  url: string
}

export function clipboardImages(event: Pick<ClipboardEvent, 'clipboardData'>): File[] {
  const data = event.clipboardData
  if (!data) return []
  if (data.files.length > 0) {
    return [...data.files].filter((file) => file.type.startsWith('image/'))
  }
  return [...data.items].flatMap((item) => {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) return []
    const file = item.getAsFile()
    return file ? [file] : []
  })
}

function readImage(file: File): Promise<PastedImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Failed to read image'))
        return
      }
      const comma = reader.result.indexOf(',')
      resolve({
        id: crypto.randomUUID(),
        mimeType: file.type || 'image/png',
        data: comma === -1 ? reader.result : reader.result.slice(comma + 1),
        url: URL.createObjectURL(file)
      })
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'))
    reader.onabort = () => reject(new Error('Image read aborted'))
    reader.readAsDataURL(file)
  })
}

/** Owns preview URLs and rejects paste results that belong to a cleared draft. */
export function useComposerImages(sessionId: string | null) {
  const [images, setImages] = useState<PastedImage[]>([])
  const [preview, setPreview] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const currentImages = useRef<PastedImage[]>([])
  const generation = useRef(0)
  const currentSession = useRef(sessionId)
  currentSession.current = sessionId

  const release = useCallback(() => {
    generation.current++
    for (const image of currentImages.current) URL.revokeObjectURL(image.url)
    currentImages.current = []
  }, [])

  const clear = useCallback(() => {
    release()
    setImages([])
    setPreview(null)
    setError(null)
  }, [release])

  useEffect(() => {
    clear()
    return release
  }, [sessionId, clear, release])

  const add = useCallback(async (files: File[]) => {
    const startedFor = currentSession.current
    const startedAt = generation.current
    const results = await Promise.allSettled(files.map(readImage))
    const added = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])

    // FileReader can finish after sending, switching sessions, or unmounting.
    if (startedAt !== generation.current || startedFor !== currentSession.current) {
      for (const image of added) URL.revokeObjectURL(image.url)
      return
    }
    currentImages.current = [...currentImages.current, ...added]
    setImages(currentImages.current)
    setError(results.some((result) => result.status === 'rejected') ? '有图片读取失败，请重新粘贴。' : null)
  }, [])

  const remove = useCallback((id: string) => {
    const image = currentImages.current.find((item) => item.id === id)
    if (!image) return
    URL.revokeObjectURL(image.url)
    currentImages.current = currentImages.current.filter((item) => item.id !== id)
    setImages(currentImages.current)
    setPreview((current) => current === image.url ? null : current)
  }, [])

  const restore = useCallback((saved: PastedImage[]) => {
    const restored = saved.map((image) => ({
      ...image,
      url: `data:${image.mimeType};base64,${image.data}`
    }))
    currentImages.current = [...restored, ...currentImages.current]
    setImages(currentImages.current)
  }, [])

  return { images, preview, error, setPreview, add, clear, remove, restore, getImages: () => currentImages.current }
}
