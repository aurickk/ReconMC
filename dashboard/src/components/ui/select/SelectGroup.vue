<script setup lang="ts">
import type { SelectGroupProps } from "reka-ui"
import { SelectGroup } from "reka-ui"

defineProps<SelectGroupProps>()
</script>

<template>
  <SelectGroup>
    <slot />
  </SelectGroup>
</template>
