<script setup lang="ts">
import type { CollapsibleRootProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { CollapsibleRoot } from "reka-ui"
import { cn } from "@/lib/utils"

const props = defineProps<
  CollapsibleRootProps & { class?: HTMLAttributes["class"] }
>()

const delegatedProps = reactiveOmit(props, "class")
</script>

<template>
  <CollapsibleRoot
    data-slot="collapsible"
    v-bind="delegatedProps"
    :class="cn(props.class)"
  >
    <slot />
  </CollapsibleRoot>
</template>
