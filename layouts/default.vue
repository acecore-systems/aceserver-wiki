<template>
  <div class="Wrapper">
    <Header :app="app" />
    <Nuxt />
  </div>
</template>

<script>
import { mapGetters } from 'vuex'
export default {
  computed: {
    ...mapGetters(['app']),
  },
}
</script>
