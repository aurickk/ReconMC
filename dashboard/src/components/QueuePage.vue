<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { toast } from 'vue-sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import type { QueueEntry } from '@/lib/types';
import { formatRelativeTime, formatDateTime } from '@/lib/utils';
import { ChevronLeft, ChevronRight, Loader2, Plus, X } from 'lucide-vue-next';

const entries = ref<QueueEntry[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const statusFilter = ref<'all' | 'pending' | 'processing'>('all');
const page = ref(1);
const pageSize = 25;
let pollInterval: ReturnType<typeof setInterval> | null = null;

const isAddOpen = ref(false);
const addServersText = ref('');
const addLoading = ref(false);

const cancellingId = ref<string | null>(null);

async function fetchData(isInitial = false) {
  if (isInitial) {
    loading.value = true;
  }
  error.value = null;

  const offset = (page.value - 1) * pageSize;
  
  // "all" should only show pending + processing (active queue items)
  const apiStatus = statusFilter.value === 'all' ? 'all' : statusFilter.value;
  const res = await api.getQueueEntries(apiStatus, pageSize, offset);

  if (res.data) {
    // Filter out completed/failed when showing "all"
    if (statusFilter.value === 'all') {
      entries.value = res.data.filter(e => e.status === 'pending' || e.status === 'processing');
    } else {
      entries.value = res.data;
    }
  }

  if (res.error) {
    error.value = res.error;
  }

  if (isInitial) {
    loading.value = false;
  }
}

function getStatusBadgeClass(status: string): string {
  switch (status) {
    case 'pending': return 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20';
    case 'processing': return 'bg-blue-500/10 text-blue-600 border-blue-500/20';
    default: return 'bg-gray-500/10 text-gray-600 border-gray-500/20';
  }
}

function setPage(newPage: number) {
  page.value = newPage;
  fetchData(true);
}

function setStatusFilter(status: typeof statusFilter.value) {
  statusFilter.value = status;
  page.value = 1;
  fetchData(true);
}

function openAddDialog() {
  addServersText.value = '';
  isAddOpen.value = true;
}

async function addToQueue() {
  if (!addServersText.value.trim()) {
    toast.error('Please enter server addresses');
    return;
  }

  addLoading.value = true;
  const servers = addServersText.value
    .trim()
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  if (servers.length === 0) {
    toast.error('No valid server addresses found');
    addLoading.value = false;
    return;
  }

  const res = await api.addToQueue(servers);
  addLoading.value = false;

  if (res.data) {
    const { added, skipped } = res.data;
    if (added > 0 && skipped > 0) {
      toast.success(`Added ${added} servers, skipped ${skipped} duplicates`);
    } else if (added > 0) {
      toast.success(`Added ${added} servers to queue`);
    } else {
      toast.info(`All ${skipped} servers were duplicates`);
    }
    isAddOpen.value = false;
    fetchData(false);
  }
  if (res.error) {
    toast.error('Failed to add servers: ' + res.error);
  }
}

async function cancelScan(entry: QueueEntry) {
  cancellingId.value = entry.id;
  const res = await api.cancelQueueEntry(entry.id);
  cancellingId.value = null;

  if (res.error) {
    toast.error('Failed to cancel scan: ' + res.error);
  } else {
    toast.success(`Cancelled scan for ${entry.serverAddress}`);
    fetchData(false);
  }
}

onMounted(() => {
  fetchData(true);
  pollInterval = setInterval(() => fetchData(false), 5000);
});

onUnmounted(() => {
  if (pollInterval) {
    clearInterval(pollInterval);
  }
});
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-3xl font-bold tracking-tight">Scan Queue</h2>
        <p class="text-muted-foreground">
          Active scans - pending and in progress
        </p>
      </div>
      <Dialog v-model:open="isAddOpen">
        <DialogTrigger as-child>
          <Button @click="openAddDialog">
            <Plus class="mr-2 h-4 w-4" />
            Add Servers
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Servers to Queue</DialogTitle>
            <DialogDescription>
              Enter server addresses to add to the scan queue
            </DialogDescription>
          </DialogHeader>
          <div class="space-y-4">
            <div class="space-y-2">
              <Label for="servers">Server Addresses</Label>
              <Textarea 
                id="servers" 
                v-model="addServersText" 
                rows="8" 
                placeholder="mc.example.com&#10;mc.example.com:25565&#10;192.168.1.1:25566"
              />
            </div>
            <p class="text-sm text-muted-foreground">
              One server per line. Format: <code class="bg-muted px-1 rounded">host</code> or <code class="bg-muted px-1 rounded">host:port</code>
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" @click="isAddOpen = false">Cancel</Button>
            <Button @click="addToQueue" :disabled="addLoading">
              <Loader2 v-if="addLoading" class="mr-2 h-4 w-4 animate-spin" />
              Add Servers
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>

    <div class="flex items-center gap-2 flex-wrap">
      <Button
        :variant="statusFilter === 'all' ? 'default' : 'outline'"
        size="sm"
        @click="setStatusFilter('all')"
      >
        All
      </Button>
      <Button
        :variant="statusFilter === 'pending' ? 'default' : 'outline'"
        size="sm"
        @click="setStatusFilter('pending')"
      >
        Pending
      </Button>
      <Button
        :variant="statusFilter === 'processing' ? 'default' : 'outline'"
        size="sm"
        @click="setStatusFilter('processing')"
      >
        Processing
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
              <TableHead>Server Address</TableHead>
              <TableHead>IP/Hostname</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>Submitted</TableHead>
              <TableHead>Started</TableHead>
              <TableHead class="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow 
              v-for="entry in entries" 
              :key="entry.id"
              :class="{ 'animate-pulse': entry.status === 'processing' }"
            >
              <TableCell class="font-medium">
                {{ entry.hostname || entry.serverAddress }}:{{ entry.port }}
              </TableCell>
              <TableCell class="text-muted-foreground">
                {{ entry.resolvedIp || '—' }}
              </TableCell>
              <TableCell>
                <Badge variant="outline" :class="getStatusBadgeClass(entry.status)">
                  <Loader2 v-if="entry.status === 'processing'" class="mr-1 h-3 w-3 animate-spin" />
                  {{ entry.status }}
                </Badge>
              </TableCell>
              <TableCell class="text-muted-foreground">
                {{ entry.assignedAgentId ? entry.assignedAgentId.slice(0, 8) : '—' }}
              </TableCell>
              <TableCell class="text-muted-foreground">
                {{ formatRelativeTime(entry.createdAt, '—') }}
              </TableCell>
              <TableCell class="text-muted-foreground">
                {{ formatRelativeTime(entry.startedAt, '—') }}
              </TableCell>
              <TableCell class="text-right">
                <Button
                  v-if="entry.status === 'pending' || entry.status === 'processing'"
                  variant="ghost"
                  size="icon"
                  @click="cancelScan(entry)"
                  :disabled="cancellingId === entry.id"
                  title="Cancel scan"
                >
                  <Loader2 v-if="cancellingId === entry.id" class="h-4 w-4 animate-spin" />
                  <X v-else class="h-4 w-4 text-destructive" />
                </Button>
                <span v-else class="text-muted-foreground">—</span>
              </TableCell>
            </TableRow>
            <TableRow v-if="entries.length === 0">
              <TableCell colspan="7" class="text-center text-muted-foreground py-8">
                <template v-if="statusFilter === 'all'">
                    No servers in queue. All scans are complete or idle.
                </template>
                <template v-else-if="statusFilter === 'pending'">
                    No pending scans. Add servers to start scanning.
                </template>
                <template v-else>
                    No servers currently processing.
                </template>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>

        <div v-if="entries.length > 0" class="flex items-center justify-between border-t px-4 py-2">
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
              :disabled="entries.length < pageSize"
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
