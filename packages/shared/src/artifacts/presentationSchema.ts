import { z } from 'zod'

export const presentationToneSchema = z.enum(['neutral', 'info', 'success', 'warning', 'error'])

export const markdownBlockSchema = z
  .object({
    type: z.literal('markdown'),
    content: z.string().min(1),
  })
  .strict()

const htmlBlockHeightSchema = z.number().int().min(120).max(4000)

export const htmlBlockSchema = z
  .object({
    type: z.literal('html'),
    content: z.string().min(1),
    iframeAccessibilityTitle: z.string().min(1).optional(),
    height: htmlBlockHeightSchema.optional(),
    minHeight: htmlBlockHeightSchema.optional(),
    maxHeight: htmlBlockHeightSchema.optional(),
  })
  .strict()

export const metricItemSchema = z
  .object({
    label: z.string().min(1),
    value: z.union([z.string().min(1), z.number()]),
    tone: presentationToneSchema.optional(),
  })
  .strict()

export const metricsBlockSchema = z
  .object({
    type: z.literal('metrics'),
    items: z.array(metricItemSchema),
  })
  .strict()

export const tableColumnSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
  })
  .strict()

export const tableBlockSchema = z
  .object({
    type: z.literal('table'),
    columns: z.array(tableColumnSchema),
    rows: z.array(z.record(z.string(), z.unknown())),
  })
  .strict()

export const chartBlockSchema = z
  .object({
    type: z.literal('chart'),
    library: z.literal('vega-lite'),
    spec: z.record(z.string(), z.unknown()),
  })
  .strict()

export const calloutBlockSchema = z
  .object({
    type: z.literal('callout'),
    title: z.string().min(1).optional(),
    content: z.string().min(1),
    tone: presentationToneSchema.optional(),
  })
  .strict()

export const timelineItemSchema = z
  .object({
    title: z.string().min(1),
    at: z.string().min(1).optional(),
    content: z.string().min(1).optional(),
  })
  .strict()

export const timelineBlockSchema = z
  .object({
    type: z.literal('timeline'),
    items: z.array(timelineItemSchema),
  })
  .strict()

export const presentationBlockSchema = z.discriminatedUnion('type', [
  markdownBlockSchema,
  htmlBlockSchema,
  metricsBlockSchema,
  tableBlockSchema,
  chartBlockSchema,
  calloutBlockSchema,
  timelineBlockSchema,
])

export const presentationSectionSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).optional(),
    blocks: z.array(presentationBlockSchema),
  })
  .strict()

export const presentationSchema = z
  .object({
    schemaVersion: z.literal(1),
    title: z.string().min(1),
    sections: z.array(presentationSectionSchema),
  })
  .strict()
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
