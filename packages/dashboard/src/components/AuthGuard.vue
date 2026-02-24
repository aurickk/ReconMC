<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useAuth } from '@/composables/useAuth';
import LoginPage from '@/components/LoginPage.vue';

const { authState, checkAuthStatus } = useAuth();
const initialized = ref(false);

onMounted(async () => {
  await checkAuthStatus();
  initialized.value = true;
});
</script>

<template>
  <div v-if="!initialized" class="min-h-screen flex items-center justify-center bg-background">
    <div class="animate-pulse text-muted-foreground">Loading...</div>
  </div>
  <LoginPage v-else-if="!authState.isAuthenticated" />
  <slot v-else />
</template>
