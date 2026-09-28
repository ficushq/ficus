import { defineCollection } from 'astro:content'
import { docsLoader, i18nLoader } from '@astrojs/starlight/loaders'
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema'

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: (context) =>
      docsSchema()(context).transform((data) => {
        if (process.env.FICUS_DOCS_EMBEDDED === '1') {
          for (const key of ['prev', 'next'] as const) {
            const link = data[key]
            if (
              link &&
              typeof link === 'object' &&
              link.link?.startsWith('/') &&
              !link.link.startsWith('//') &&
              !/^\/docs(?:\/|$|[?#])/.test(link.link)
            )
              link.link = `/docs${link.link}`
          }
        }
        return data
      }),
  }),
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
}
