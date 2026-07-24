import type { WikiData } from '#shared/types/wiki'

const emptyWikiData = (): WikiData => ({
  app: null,
  links: [],
  categories: [],
  articles: [],
})

export const useWikiData = () =>
  useAsyncData<WikiData>('wiki-data', () => $fetch('/api/wiki'), {
    default: emptyWikiData,
    deep: false,
  })
