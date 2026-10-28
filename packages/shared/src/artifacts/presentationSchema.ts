import { z } from 'zod'

export const presentationToneSchema = z.enum(['neutral', 'info', 'success', 'warning', 'error'])

export const markdownBlockSchema = z.strictObject({
  type: z.literal('markdown'),
  content: z.string().min(1),
})

const htmlBlockHeightSchema = z.int().min(120).max(4000)

export const htmlBlockSchema = z.strictObject({
  type: z.literal('html'),
  content: z.string().min(1),
  iframeAccessibilityTitle: z.string().min(1).optional(),
  height: htmlBlockHeightSchema.optional(),
  minHeight: htmlBlockHeightSchema.optional(),
  maxHeight: htmlBlockHeightSchema.optional(),
})

export const metricItemSchema = z.strictObject({
  label: z.string().min(1),
  value: z.union([z.string().min(1), z.number()]),
  tone: presentationToneSchema.optional(),
})

export const metricsBlockSchema = z.strictObject({
  type: z.literal('metrics'),
  items: z.array(metricItemSchema),
})

export const tableColumnSchema = z.strictObject({
  key: z.string().min(1),
  label: z.string().min(1),
})

export const tableBlockSchema = z.strictObject({
  type: z.literal('table'),
  columns: z.array(tableColumnSchema),
  rows: z.array(z.record(z.string(), z.unknown())),
})

export const chartBlockSchema = z.strictObject({
  type: z.literal('chart'),
  library: z.literal('vega-lite'),
  spec: z.record(z.string(), z.unknown()),
})

export const calloutBlockSchema = z.strictObject({
  type: z.literal('callout'),
  title: z.string().min(1).optional(),
  content: z.string().min(1),
  tone: presentationToneSchema.optional(),
})

export const timelineItemSchema = z.strictObject({
  title: z.string().min(1),
  at: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
})

export const timelineBlockSchema = z.strictObject({
  type: z.literal('timeline'),
  items: z.array(timelineItemSchema),
})

export const presentationBlockSchema = z.discriminatedUnion('type', [
  markdownBlockSchema,
  htmlBlockSchema,
  metricsBlockSchema,
  tableBlockSchema,
  chartBlockSchema,
  calloutBlockSchema,
  timelineBlockSchema,
])

export const presentationSectionSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  blocks: z.array(presentationBlockSchema),
})

export const presentationSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    title: z.string().min(1),
    sections: z.array(presentationSectionSchema),
  })
  .superRefine((presentation, context) => {
    presentation.sections.forEach((section, sectionIndex) => {
      section.blocks.forEach((block, blockIndex) => {
        if (
          block.type === 'html' &&
          block.minHeight !== undefined &&
          block.maxHeight !== undefined &&
          block.minHeight > block.maxHeight
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'minHeight must be less than or equal to maxHeight',
            path: ['sections', sectionIndex, 'blocks', blockIndex, 'minHeight'],
          })
        }
      })
    })
  })

export type PresentationTone = z.infer<typeof presentationToneSchema>
export type MarkdownBlock = z.infer<typeof markdownBlockSchema>
export type HtmlBlock = z.infer<typeof htmlBlockSchema>
export type MetricItem = z.infer<typeof metricItemSchema>
export type MetricsBlock = z.infer<typeof metricsBlockSchema>
export type TableColumn = z.infer<typeof tableColumnSchema>
export type TableBlock = z.infer<typeof tableBlockSchema>
export type ChartBlock = z.infer<typeof chartBlockSchema>
export type CalloutBlock = z.infer<typeof calloutBlockSchema>
export type TimelineItem = z.infer<typeof timelineItemSchema>
export type TimelineBlock = z.infer<typeof timelineBlockSchema>
export type PresentationBlock = z.infer<typeof presentationBlockSchema>
export type PresentationSection = z.infer<typeof presentationSectionSchema>
export type Presentation = z.infer<typeof presentationSchema>
