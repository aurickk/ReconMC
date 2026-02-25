<script setup lang="ts">
import { ref } from 'vue';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/composables/useAuth';

const { verifyApiKey, loading, error } = useAuth();

const apiKey = ref('');
const localError = ref('');

async function handleSubmit() {
  localError.value = '';
  
  if (!apiKey.value.trim()) {
    localError.value = 'API key is required';
    return;
  }

  const success = await verifyApiKey(apiKey.value.trim());
  if (success) {
    window.location.href = '/';
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-background p-4">
    <Card class="w-full max-w-md">
      <CardHeader class="text-center">
        <CardTitle class="text-2xl">ReconMC</CardTitle>
        <CardDescription>
          Enter your API key to access the dashboard
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form @submit.prevent="handleSubmit" class="space-y-4">
          <div class="space-y-2">
            <Label for="apiKey">API Key</Label>
            <Input
              id="apiKey"
              v-model="apiKey"
              type="password"
              placeholder="Enter your API key"
              :disabled="loading"
              autocomplete="off"
            />
          </div>
          
          <div v-if="localError || error" class="text-sm text-destructive">
            {{ localError || error }}
          </div>
          
          <Button type="submit" class="w-full" :disabled="loading">
            {{ loading ? 'Verifying...' : 'Sign In' }}
          </Button>
        </form>
      </CardContent>
    </Card>
  </div>
</template>
