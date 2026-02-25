<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { api } from '@/lib/api';
import type { Server } from '@/lib/types';
import { formatRelativeTime } from '@/lib/utils';
import { toast } from 'vue-sonner';
import { RefreshCw, Trash2, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-vue-next';

const servers = ref<Server[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const statusFilter = ref<'all' | 'online' | 'offline'>('all');
const page = ref(1);
const pageSize = 25;
let pollInterval: ReturnType<typeof setInterval> | null = null;

const deleteServerId = ref<string | null>(null);
const deleteDialogOpen = ref(false);

async function fetchData(isInitial = false) {
  if (isInitial) {
    loading.value = true;
  }
  error.value = null;

  const offset = (page.value - 1) * pageSize;
  const res = await api.getServersWithPagination(pageSize, offset);

  if (res.data) {
    let filtered = res.data.servers;
    if (statusFilter.value !== 'all') {
      const isOnline = statusFilter.value === 'online';
      filtered = filtered.filter(s => {
        const online = s.latestResult?.online ?? false;
        return online === isOnline;
      });
    }
    servers.value = filtered;
  }

  if (res.error) {
    error.value = res.error;
  }

  if (isInitial) {
    loading.value = false;
  }
}

async function handleRescan(server: Server) {
  const address = server.hostname || server.serverAddress;
  const res = await api.addToQueue([`${address}:${server.port}`]);
  if (res.data) {
    toast.success(`Added ${address} to queue`);
  } else {
    toast.error(res.error || 'Failed to add to queue');
  }
}

async function handleDelete() {
  if (!deleteServerId.value) return;
  
  const res = await api.deleteServer(deleteServerId.value);
  if (res.data) {
    servers.value = servers.value.filter(s => s.id !== deleteServerId.value);
    toast.success('Server deleted');
  } else {
    toast.error(res.error || 'Failed to delete server');
  }
  deleteServerId.value = null;
  deleteDialogOpen.value = false;
}

function openDeleteDialog(id: string) {
  deleteServerId.value = id;
  deleteDialogOpen.value = true;
}

function getStatusBadgeClass(server: Server): string {
  const online = server.latestResult?.online ?? false;
  if (!server.lastScannedAt) return 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20';
  return online 
    ? 'bg-green-500/10 text-green-600 border-green-500/20'
    : 'bg-red-500/10 text-red-600 border-red-500/20';
}

function getStatusLabel(server: Server): string {
  if (!server.lastScannedAt) return 'Pending';
  return server.latestResult?.online ? 'Online' : 'Offline';
}

function getModeBadgeClass(server: Server): string {
  const accountType = server.latestResult?.accountType;
  if (accountType === 'microsoft') return 'bg-green-500/10 text-green-600 border-green-500/20';
  if (accountType === 'cracked') return 'bg-red-500/10 text-red-600 border-red-500/20';
  return 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20';
}

function getModeLabel(server: Server): string {
  const accountType = server.latestResult?.accountType;
  if (accountType === 'microsoft') return 'Online';
  if (accountType === 'cracked') return 'Cracked';
  return 'Unknown';
}

function setPage(newPage: number) {
  page.value = newPage;
  fetchData(true);
}

function setStatusFilter(status: 'all' | 'online' | 'offline') {
  statusFilter.value = status;
  page.value = 1;
  fetchData(true);
}

onMounted(() => {
  fetchData(true);
  pollInterval = setInterval(() => fetchData(false), 15000);
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
      <h2 class="text-3xl font-bold tracking-tight">Servers</h2>
      <p class="text-muted-foreground">
        Browse all discovered Minecraft servers
      </p>
    </div>

    <div class="flex items-center gap-2">
      <Button
        :variant="statusFilter === 'all' ? 'default' : 'outline'"
        size="sm"
        @click="setStatusFilter('all')"
      >
        All
      </Button>
      <Button
        :variant="statusFilter === 'online' ? 'default' : 'outline'"
        size="sm"
        @click="setStatusFilter('online')"
      >
        Online
      </Button>
      <Button
        :variant="statusFilter === 'offline' ? 'default' : 'outline'"
        size="sm"
        @click="setStatusFilter('offline')"
      >
        Offline
      </Button>
    </div>

    <Card>
      <CardContent class="p-0">
        <div v-if="loading" class="p-4 space-y-3">
          <Skeleton class="h-10 w-full" />
          <Skeleton class="h-10 w-full" />
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
              <TableHead>Address</TableHead>
              <TableHead>IP/Hostname</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead>Last Scanned</TableHead>
              <TableHead class="text-right">Scans</TableHead>
              <TableHead class="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="server in servers" :key="server.id">
              <TableCell class="font-medium">
                {{ server.hostname || server.serverAddress }}:{{ server.port }}
              </TableCell>
              <TableCell class="text-muted-foreground">
                {{ server.resolvedIp || '—' }}
              </TableCell>
              <TableCell>
                <Badge variant="outline" :class="getStatusBadgeClass(server)">
                  {{ getStatusLabel(server) }}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge variant="outline" :class="getModeBadgeClass(server)">
                  {{ getModeLabel(server) }}
                </Badge>
              </TableCell>
              <TableCell>{{ formatRelativeTime(server.lastScannedAt) }}</TableCell>
              <TableCell class="text-right">{{ server.scanCount ?? 0 }}</TableCell>
              <TableCell class="text-right">
                <div class="flex justify-end gap-1">
                  <a :href="`/server?id=${server.id}`" title="View Details">
                    <Button variant="ghost" size="icon">
                      <ExternalLink class="h-4 w-4" />
                    </Button>
                  </a>
                  <Button variant="ghost" size="icon" @click="handleRescan(server)" title="Rescan">
                    <RefreshCw class="h-4 w-4" />
                  </Button>
                  <AlertDialog v-model:open="deleteDialogOpen">
                    <AlertDialogTrigger as-child>
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        class="text-destructive hover:text-destructive"
                        @click="openDeleteDialog(server.id)"
                        title="Delete"
                      >
                        <Trash2 class="h-4 w-4" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete this server?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will permanently delete the server and all scan history. This action cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction 
                          class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          @click="handleDelete"
                        >
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </TableCell>
            </TableRow>
            <TableRow v-if="servers.length === 0">
              <TableCell colspan="7" class="text-center text-muted-foreground py-8">
                No servers scanned yet. Add servers to the queue to get started.
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>

        <div v-if="servers.length > 0" class="flex items-center justify-between border-t px-4 py-2">
          <p class="text-sm text-muted-foreground">
            Page {{ page }}
          </p>
          <div class="flex gap-1">
            <Button 
              variant="outline" 
              size="icon" 
              :disabled="page <= 1"
              @click="setPage(page - 1)"
            >
              <ChevronLeft class="h-4 w-4" />
            </Button>
            <Button 
              variant="outline" 
              size="icon"
              :disabled="servers.length < pageSize"
              @click="setPage(page + 1)"
            >
              <ChevronRight class="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
