<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import type { Agent } from '@/lib/types';
import { Activity, Clock, Server, Zap } from 'lucide-vue-next';

const agents = ref<Agent[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
let pollInterval: ReturnType<typeof setInterval> | null = null;

async function fetchData() {
  const res = await api.getAgents();
  
  if (res.data) {
    agents.value = res.data;
  } else {
    error.value = res.error || 'Failed to load agents';
  }
  
  loading.value = false;
}

function getStatusBadge(status: string): { class: string; label: string } {
  switch (status.toLowerCase()) {
    case 'scanning':
    case 'busy':
      return { class: 'bg-green-500/10 text-green-600 border-green-500/20', label: 'Scanning' };
    case 'idle':
      return { class: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20', label: 'Idle' };
    case 'offline':
    case 'disconnected':
      return { class: 'bg-red-500/10 text-red-600 border-red-500/20', label: 'Offline' };
    default:
      return { class: 'bg-gray-500/10 text-gray-600 border-gray-500/20', label: status };
  }
}

function formatLastSeen(timestamp: string | null): string {
  if (!timestamp) return 'Never';
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  
  if (diffSecs < 60) return `${diffSecs}s ago`;
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return date.toLocaleDateString();
}

function isOnline(timestamp: string | null): boolean {
  if (!timestamp) return false;
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  return diffMs < 5 * 60 * 1000;
}

const sortedAgents = computed(() => {
  return [...agents.value].sort((a, b) => {
    const aOnline = isOnline(a.lastSeenAt);
    const bOnline = isOnline(b.lastSeenAt);
    if (aOnline && !bOnline) return -1;
    if (!aOnline && bOnline) return 1;
    
    const aTime = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
    const bTime = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
    return bTime - aTime;
  });
});

const stats = computed(() => {
  const total = agents.value.length;
  const online = agents.value.filter(a => isOnline(a.lastSeenAt)).length;
  const scanning = agents.value.filter(a => a.status?.toLowerCase() === 'scanning' || a.status?.toLowerCase() === 'busy').length;
  return { total, online, scanning };
});

onMounted(() => {
  fetchData();
  pollInterval = setInterval(fetchData, 10000);
});

onUnmounted(() => {
  if (pollInterval) {
    clearInterval(pollInterval);
  }
});
</script>

<template>
  <div class="space-y-6">
    <div>
      <h2 class="text-3xl font-bold tracking-tight">Agents</h2>
      <p class="text-muted-foreground">
        Monitor distributed scan agents
      </p>
    </div>

    <div class="grid gap-4 md:grid-cols-3">
      <Card>
        <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle class="text-sm font-medium">Total Agents</CardTitle>
          <Server class="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold">{{ stats.total }}</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle class="text-sm font-medium">Online</CardTitle>
          <Activity class="h-4 w-4 text-green-500" />
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold">{{ stats.online }}</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle class="text-sm font-medium">Scanning</CardTitle>
          <Zap class="h-4 w-4 text-yellow-500" />
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold">{{ stats.scanning }}</div>
        </CardContent>
      </Card>
    </div>

    <Card>
      <CardContent class="p-0">
        <div v-if="loading" class="p-4 space-y-3">
          <Skeleton class="h-10 w-full" />
          <Skeleton class="h-10 w-full" />
          <Skeleton class="h-10 w-full" />
        </div>

        <div v-else-if="error" class="p-4 text-destructive">
          Error: {{ error }}
        </div>

        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead>Agent ID</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Current Task</TableHead>
              <TableHead>Last Heartbeat</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="agent in sortedAgents" :key="agent.id">
              <TableCell class="font-mono text-xs">
                {{ agent.id.slice(0, 8) }}...
              </TableCell>
              <TableCell>
                {{ agent.name || '—' }}
              </TableCell>
              <TableCell>
                <Badge variant="outline" :class="getStatusBadge(agent.status).class">
                  {{ getStatusBadge(agent.status).label }}
                </Badge>
              </TableCell>
              <TableCell class="font-mono text-xs">
                <span v-if="agent.taskAddress" class="text-primary">
                  {{ agent.taskAddress }}
                </span>
                <span v-else class="text-muted-foreground">Idle</span>
              </TableCell>
              <TableCell>
                <div class="flex items-center gap-1">
                  <Clock class="h-3 w-3 text-muted-foreground" />
                  {{ formatLastSeen(agent.lastSeenAt) }}
                </div>
              </TableCell>
            </TableRow>
            <TableRow v-if="agents.length === 0">
              <TableCell colspan="5" class="text-center text-muted-foreground py-8">
                No agents registered yet. Start an agent to begin scanning.
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  </div>
</template>
