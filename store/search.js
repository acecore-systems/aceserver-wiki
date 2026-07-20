export const state = () => ({
  searchText: '',
  isLoading: false,
  searchResults: [],
  numberOfSearchResult: 0,
})

export const getters = {
  searchText: (state) => state.searchText,
  isLoading: (state) => state.isLoading,
  searchResults: (state) => state.searchResults,
  numberOfSearchResult: (state) => state.numberOfSearchResult,
}

export const mutations = {
  setSearchText(state, searchText) {
    state.searchText = searchText
  },
  setIsLoading(state, isLoading = false) {
    state.isLoading = isLoading
  },
  setSearchResults(state, articles = []) {
    state.searchResults = articles
  },
  setNumberOfSearchResult(state, number = 0) {
    state.numberOfSearchResult = number
  },
}

export const actions = {
  init: ({ commit }) => {
    commit('setSearchText', '')
    commit('setIsLoading', true)
    commit('setSearchResults', [])
    commit('setNumberOfSearchResult', 0)
  },
  searchArticles({ commit }, { articles = [], searchText }) {
    commit('setSearchText', searchText)
    commit('setIsLoading', true)
    commit('setSearchResults', [])
    commit('setNumberOfSearchResult', 0)

    const query = String(searchText || '')
      .trim()
      .toLocaleLowerCase()
    const items = query
      ? articles.filter((article) =>
          `${article.title} ${article.text}`.toLocaleLowerCase().includes(query)
        )
      : []

    commit('setSearchResults', items)
    commit('setNumberOfSearchResult', items.length)
    commit('setIsLoading', false)
  },
}
