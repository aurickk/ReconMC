<script setup lang="ts">
import {
  Server,
  Users,
  Shield,
  Scan,
  Zap,
} from 'lucide-vue-next';
import { Toaster } from 'vue-sonner';

defineProps<{
  title?: string;
}>();

const navigation = [
  { name: 'Scan Queue', href: '/', icon: Scan },
  { name: 'Servers', href: '/servers', icon: Server },
  { name: 'Agents', href: '/agents', icon: Zap },
  { name: 'Accounts', href: '/accounts', icon: Users },
  { name: 'Proxies', href: '/proxies', icon: Shield },
];
</script>

<template>
  <div class="flex min-h-screen w-full">
    <!-- Toast notifications -->
    <Toaster position="bottom-right" :expand="true" rich-colors />
    
    <!-- Sidebar -->
    <aside class="fixed inset-y-0 left-0 z-50 w-64 border-r bg-sidebar">
      <div class="flex h-full flex-col">
        <!-- Header -->
        <div class="flex h-14 items-center gap-2 border-b px-4">
          <Server class="h-6 w-6 text-primary" />
          <span class="text-lg font-semibold">ReconMC</span>
        </div>
        
        <!-- Navigation -->
        <nav class="flex-1 overflow-auto p-4">
          <div class="text-xs font-medium text-muted-foreground mb-2">Navigation</div>
          <ul class="space-y-1">
            <li v-for="item in navigation" :key="item.name">
              <a
                :href="item.href"
                class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <component :is="item.icon" class="h-4 w-4" />
                {{ item.name }}
              </a>
            </li>
          </ul>
        </nav>
      </div>
    </aside>

    <!-- Main content -->
    <div class="flex-1 ml-64">
      <!-- Header -->
      <header class="sticky top-0 z-40 flex h-14 items-center gap-4 border-b bg-background px-4 lg:px-6">
        <div class="flex-1">
          <h1 class="text-lg font-semibold">{{ title || 'ReconMC' }}</h1>
        </div>
      </header>
      
      <!-- Page content -->
      <main class="flex-1 p-4 lg:p-6">
        <slot />
      </main>
    </div>
  </div>
</template>
