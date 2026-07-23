export interface WikiApp {
  name: string
  uid: string
  icon?: {
    type: string
    value: string
  }
}

export interface WikiLink {
  _id: string
  text: string
  href: string
}

export interface WikiCategory {
  _id: string
  name: string
}

export interface WikiArticleSummary {
  _id: string
  title: string
  slug: string
  category?: WikiCategory
}

export interface WikiArticle extends WikiArticleSummary {
  body?: string
  meta?: {
    title?: string
    description?: string
    ogImage?: {
      src: string
    }
  }
}

export interface WikiSearchSource {
  _id: string
  title: string
  slug: string
  body?: string
}

export interface WikiSearchItem {
  _id: string
  title: string
  slug: string
  text: string
}

export interface WikiData {
  app: WikiApp | null
  links: WikiLink[]
  categories: WikiCategory[]
  articles: WikiArticleSummary[]
}
