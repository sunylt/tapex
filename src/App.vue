<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { RouterView } from 'vue-router'

import AppHeader from '@/components/AppHeader.vue'
import { useMiningStore } from '@/stores/mining'

const mining = useMiningStore()

// The header wallet button lives on every page, so the wallet lifecycle is
// owned by the app shell rather than by an individual view.
onMounted(() => void mining.init())
onUnmounted(() => mining.teardown())
</script>

<template>
  <AppHeader />
  <RouterView />
</template>
