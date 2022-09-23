<template>
  <div :style="'background-image: url(' + img + ');'" style="height: 18rem">
    &nbsp;
  </div>
</template>

<script>
export default {
  props: {
    img: {
      type: String,
      default: '',
    }
  }
}
</script>
