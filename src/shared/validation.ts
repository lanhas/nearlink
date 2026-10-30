import { z } from 'zod'

export const idSchema = z.string().regex(/^[a-zA-Z0-9:_-]{1,160}$/)
export const profileSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().trim().min(1).max(48),
  deviceName: z.string().trim().min(1).max(64),
  status: z.string().max(120),
  color: z.string().regex(/^#[a-fA-F0-9]{6}$/),
  avatar: z
    .string()
    .max(100_000)
    .refine((v) => !v || /^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(v)),
  platform: z.enum(['darwin', 'win32', 'linux'])
})
export const attachmentSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(240),
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  mime: z.string().min(1).max(100),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
})
export const conversationSchema = z.object({
  id: idSchema,
  kind: z.enum(['direct', 'group']),
  title: z.string().trim().min(1).max(80),
  members: z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .min(2)
    .max(64),
  createdBy: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number().int().positive()
})
export const wireMessageSchema = z
  .object({
    id: z.uuid(),
    conversationId: idSchema,
    senderId: z.string().regex(/^[a-f0-9]{64}$/),
    text: z.string().max(64_000),
    attachments: z.array(attachmentSchema).max(32),
    createdAt: z.number().int().positive()
  })
  .refine((v) => v.text.trim().length > 0 || v.attachments.length > 0)
const contactsSchema = z
  .array(
    z.object({
      id: z.string().regex(/^[a-f0-9]{64}$/),
      host: z.string().max(48),
      port: z.number().int().min(1).max(65535)
    })
  )
  .max(64)
  .optional()
export const eventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('conversation'),
    id: z.uuid(),
    conversation: conversationSchema,
    contacts: contactsSchema
  }),
  z.object({
    type: z.literal('message'),
    id: z.uuid(),
    conversation: conversationSchema,
    message: wireMessageSchema,
    contacts: contactsSchema
  })
])
export type WireEvent = z.infer<typeof eventSchema>
export type WireMessage = z.infer<typeof wireMessageSchema>
