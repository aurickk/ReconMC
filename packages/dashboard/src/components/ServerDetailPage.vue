<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { api } from '@/lib/api';
import type { ServerDetail, ScanHistoryEntry } from '@/lib/types';
import { toast } from 'vue-sonner';
import { 
  ArrowLeft, 
  Trash2, 
  Copy, 
  ExternalLink, 
  ChevronDown, 
  ChevronRight,
  Check,
  X,
  Clock,
  Users,
  Server,
  Wifi,
  Package,
  MapPin,
} from 'lucide-vue-next';
import MotdRenderer from './MotdRenderer.vue';

const serverId = ref<string | null>(null);

const server = ref<ServerDetail | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const selectedScanIndex = ref(0);
const deleteScanTimestamp = ref<string | null>(null);
const deleteDialogOpen = ref(false);
const logsExpanded = ref(false);

const sortedHistory = computed(() => {
  if (!server.value?.scanHistory) return [];
  return [...server.value.scanHistory].sort((a, b) => 
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
});

const selectedScan = computed(() => {
  return sortedHistory.value[selectedScanIndex.value] ?? null;
});

async function fetchServer() {
  if (!serverId.value) return;
  
  loading.value = true;
  error.value = null;
  
  const res = await api.getServer(serverId.value);
  
  if (res.data) {
    server.value = res.data as ServerDetail;
  } else {
    error.value = res.error || 'Failed to load server';
  }
  
  loading.value = false;
}

function getServerIdFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('id');
}

onMounted(() => {
  serverId.value = getServerIdFromUrl();
  if (serverId.value) {
    fetchServer();
  } else {
    error.value = 'No server ID provided';
    loading.value = false;
  }
});

function selectScan(index: number) {
  selectedScanIndex.value = index;
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleString();
}

function formatRelativeTime(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function formatDuration(ms: number | null | undefined): string {
  if (!ms) return '—';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

function getStatusBadge(scan: ScanHistoryEntry): { class: string; label: string } {
  if (scan.errorMessage) {
    return { class: 'bg-red-500/10 text-red-600 border-red-500/20', label: 'Error' };
  }
  if (scan.result?.online) {
    return { class: 'bg-green-500/10 text-green-600 border-green-500/20', label: 'Online' };
  }
  return { class: 'bg-gray-500/10 text-gray-600 border-gray-500/20', label: 'Offline' };
}

function getModeLabel(result: ScanHistoryEntry['result']): string {
  if (!result) return 'Unknown';
  if (result.accountType === 'microsoft') return 'Online';
  if (result.accountType === 'cracked') return 'Cracked';
  return 'Unknown';
}

function getModeBadgeClass(result: ScanHistoryEntry['result']): string {
  if (!result) return 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20';
  if (result.accountType === 'microsoft') return 'bg-green-500/10 text-green-600 border-green-500/20';
  if (result.accountType === 'cracked') return 'bg-red-500/10 text-red-600 border-red-500/20';
  return 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20';
}

function isValidUuid(uuid: string): boolean {
  return uuid && !uuid.startsWith('00000000');
}

async function copyToClipboard(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  } catch {
    toast.error('Failed to copy');
  }
}

function openNameMc(uuidOrName: string) {
  const url = uuidOrName.includes('-') 
    ? `https://namemc.com/profile/${uuidOrName}`
    : `https://namemc.com/search?q=${uuidOrName}`;
  window.open(url, '_blank');
}

async function handleDeleteScan() {
  if (!deleteScanTimestamp.value || !serverId.value) return;
  
  const res = await api.deleteScan(serverId.value, deleteScanTimestamp.value);
  if (res.data) {
    toast.success('Scan deleted');
    await fetchServer();
    if (selectedScanIndex.value >= sortedHistory.value.length) {
      selectedScanIndex.value = Math.max(0, sortedHistory.value.length - 1);
    }
  } else {
    toast.error(res.error || 'Failed to delete scan');
  }
  
  deleteScanTimestamp.value = null;
  deleteDialogOpen.value = false;
}

function openDeleteDialog(timestamp: string) {
  deleteScanTimestamp.value = timestamp;
  deleteDialogOpen.value = true;
}

function goBack() {
  window.location.href = '/servers';
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center gap-4">
      <Button variant="ghost" size="icon" @click="goBack">
        <ArrowLeft class="h-4 w-4" />
      </Button>
      <div>
        <h2 class="text-2xl font-bold tracking-tight">
          {{ server?.hostname || server?.serverAddress || 'Server Details' }}
        </h2>
        <p class="text-muted-foreground" v-if="server">
          {{ server.resolvedIp }}:{{ server.port }}
        </p>
      </div>
    </div>

    <div v-if="loading" class="space-y-4">
      <Skeleton class="h-32 w-full" />
      <Skeleton class="h-64 w-full" />
    </div>

    <div v-else-if="error" class="text-destructive">
      Error: {{ error }}
    </div>

    <div v-else-if="server" class="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-6">
      <Card class="h-fit">
        <CardHeader class="pb-2">
          <CardTitle class="text-sm font-medium">Scan History</CardTitle>
        </CardHeader>
        <CardContent class="p-0">
          <ScrollArea class="h-[400px]">
            <div v-if="sortedHistory.length === 0" class="p-4 text-sm text-muted-foreground">
              No scans yet. This server will be scanned when added to queue.
            </div>
            <div v-else class="divide-y">
              <div
                v-for="(scan, index) in sortedHistory"
                :key="scan.timestamp"
                class="flex items-center justify-between p-3 cursor-pointer hover:bg-muted/50 transition-colors"
                :class="{ 'bg-muted': index === selectedScanIndex }"
                @click="selectScan(index)"
              >
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <Badge variant="outline" :class="getStatusBadge(scan).class">
                      {{ getStatusBadge(scan).label }}
                    </Badge>
                    <span class="text-xs text-muted-foreground">
                      {{ formatRelativeTime(scan.timestamp) }}
                    </span>
                  </div>
                  <div class="text-xs text-muted-foreground mt-1">
                    Duration: {{ formatDuration(scan.duration) }}
                  </div>
                </div>
                <AlertDialog v-model:open="deleteDialogOpen">
                  <AlertDialogTrigger as-child>
                    <Button
                      variant="ghost"
                      size="icon"
                      class="h-6 w-6 opacity-0 group-hover:opacity-100 hover:opacity-100"
                      @click.stop="openDeleteDialog(scan.timestamp)"
                    >
                      <Trash2 class="h-3 w-3 text-muted-foreground hover:text-destructive" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete this scan?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will remove this scan from the history. This action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        @click="handleDeleteScan"
                      >
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      <div class="space-y-4" v-if="selectedScan">
        <Card>
          <CardHeader class="pb-2">
            <CardTitle class="text-sm font-medium flex items-center gap-2">
              <Server class="h-4 w-4" />
              Server Info
            </CardTitle>
          </CardHeader>
          <CardContent class="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <div class="text-muted-foreground">Address</div>
              <div class="font-mono">{{ server.hostname || server.serverAddress }}:{{ server.port }}</div>
            </div>
            <div>
              <div class="text-muted-foreground">Resolved IP</div>
              <div class="font-mono">{{ server.resolvedIp || '—' }}</div>
            </div>
            <div>
              <div class="text-muted-foreground">Mode</div>
              <Badge variant="outline" :class="getModeBadgeClass(selectedScan.result)">
                {{ getModeLabel(selectedScan.result) }}
              </Badge>
            </div>
            <div>
              <div class="text-muted-foreground">Status</div>
              <Badge variant="outline" :class="getStatusBadge(selectedScan).class">
                {{ getStatusBadge(selectedScan).label }}
              </Badge>
            </div>
          </CardContent>
        </Card>

        <Card v-if="selectedScan.result?.motd || selectedScan.errorMessage">
          <CardHeader class="pb-2">
            <CardTitle class="text-sm font-medium">MOTD</CardTitle>
          </CardHeader>
          <CardContent>
            <MotdRenderer v-if="selectedScan.result?.motd" :motd="selectedScan.result.motd" />
            <div v-else-if="selectedScan.errorMessage" class="text-destructive text-sm">
              {{ selectedScan.errorMessage }}
            </div>
          </CardContent>
        </Card>

        <Card v-if="selectedScan.result">
          <CardHeader class="pb-2">
            <CardTitle class="text-sm font-medium flex items-center gap-2">
              <Wifi class="h-4 w-4" />
              Version
            </CardTitle>
          </CardHeader>
          <CardContent class="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div class="text-muted-foreground">Server Version</div>
              <div>{{ selectedScan.result.version || '—' }}</div>
            </div>
            <div>
              <div class="text-muted-foreground">Protocol</div>
              <div>{{ selectedScan.result.protocol ?? '—' }}</div>
            </div>
          </CardContent>
        </Card>

        <Card v-if="selectedScan.result">
          <CardHeader class="pb-2">
            <CardTitle class="text-sm font-medium flex items-center gap-2">
              <Users class="h-4 w-4" />
              Players
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div class="flex items-center gap-4 mb-4">
              <div class="text-2xl font-bold">
                {{ selectedScan.result.playersOnline ?? 0 }}
                <span class="text-muted-foreground font-normal">/</span>
                <span class="text-muted-foreground">{{ selectedScan.result.playersMax ?? 0 }}</span>
              </div>
              <div class="text-sm text-muted-foreground">online</div>
            </div>
            
            <div v-if="selectedScan.result.players && selectedScan.result.players.length > 0">
              <div class="text-sm font-medium mb-2">Player Sample</div>
              <div class="space-y-2">
                <div
                  v-for="player in selectedScan.result.players"
                  :key="player.id || player.name"
                  class="flex items-center justify-between p-2 rounded-md bg-muted/50"
                >
                  <div class="flex items-center gap-2">
                    <component
                      :is="isValidUuid(player.id) ? Check : X"
                      class="h-4 w-4"
                      :class="isValidUuid(player.id) ? 'text-green-500' : 'text-red-500'"
                    />
                    <span class="font-mono text-sm">{{ player.name }}</span>
                  </div>
                  <div class="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      class="h-6 w-6"
                      @click="copyToClipboard(player.id, 'UUID')"
                      title="Copy UUID"
                    >
                      <Copy class="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      class="h-6 w-6"
                      @click="openNameMc(player.id || player.name)"
                      title="Open NameMC"
                    >
                      <ExternalLink class="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              </div>
            </div>
            <div v-else class="text-sm text-muted-foreground">
              No players online during scan
            </div>
          </CardContent>
        </Card>

        <Card v-if="selectedScan.result?.connection">
          <CardHeader class="pb-2">
            <CardTitle class="text-sm font-medium">Connection Info</CardTitle>
          </CardHeader>
          <CardContent class="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <div>
              <div class="text-muted-foreground">Username</div>
              <div>{{ selectedScan.result.connection.username || '—' }}</div>
            </div>
            <div>
              <div class="text-muted-foreground">UUID</div>
              <div class="flex items-center gap-1">
                <span class="font-mono text-xs truncate max-w-[150px]">
                  {{ selectedScan.result.connection.uuid || '—' }}
                </span>
                <Button
                  v-if="selectedScan.result.connection.uuid"
                  variant="ghost"
                  size="icon"
                  class="h-5 w-5"
                  @click="copyToClipboard(selectedScan.result.connection.uuid, 'UUID')"
                >
                  <Copy class="h-3 w-3" />
                </Button>
              </div>
            </div>
            <div>
              <div class="text-muted-foreground">Account Type</div>
              <div>{{ selectedScan.result.connection.accountType || '—' }}</div>
            </div>
          </CardContent>
        </Card>

        <Card v-if="selectedScan.result?.plugins && selectedScan.result.plugins.length > 0">
          <CardHeader class="pb-2">
            <CardTitle class="text-sm font-medium flex items-center gap-2">
              <Package class="h-4 w-4" />
              Plugins ({{ selectedScan.result.plugins.length }})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div class="flex flex-wrap gap-2">
              <Badge
                v-for="plugin in selectedScan.result.plugins"
                :key="plugin.name"
                variant="secondary"
                class="font-mono"
              >
                {{ plugin.name }}
                <span v-if="plugin.version" class="text-muted-foreground ml-1">
                  v{{ plugin.version }}
                </span>
              </Badge>
            </div>
          </CardContent>
        </Card>

        <Card v-if="selectedScan.result?.geo">
          <CardHeader class="pb-2">
            <CardTitle class="text-sm font-medium flex items-center gap-2">
              <MapPin class="h-4 w-4" />
              Location
            </CardTitle>
          </CardHeader>
          <CardContent class="text-sm">
            <div class="flex items-center gap-2">
              <span class="text-2xl">
                {{ selectedScan.result.geo.countryCode ? 
                  String.fromCodePoint(...[...selectedScan.result.geo.countryCode].map(c => c.charCodeAt(0) + 127397)) : 
                  '🌍' }}
              </span>
              <span>{{ selectedScan.result.geo.country }}</span>
            </div>
          </CardContent>
        </Card>

        <Collapsible v-if="selectedScan.logs && selectedScan.logs.length > 0" v-model:open="logsExpanded">
          <Card>
            <CardHeader class="pb-2">
              <CollapsibleTrigger as-child>
                <CardTitle class="text-sm font-medium flex items-center gap-2 cursor-pointer">
                  <Clock class="h-4 w-4" />
                  Agent Logs
                  <component :is="logsExpanded ? ChevronDown : ChevronRight" class="h-4 w-4 ml-auto" />
                </CardTitle>
              </CollapsibleTrigger>
            </CardHeader>
            <CollapsibleContent>
              <CardContent>
                <ScrollArea class="h-[200px]">
                  <div class="space-y-1 font-mono text-xs">
                    <div
                      v-for="log in selectedScan.logs"
                      :key="log.timestamp"
                      :class="{
                        'text-red-500': log.level === 'error',
                        'text-yellow-500': log.level === 'warn',
                        'text-muted-foreground': log.level === 'debug',
                      }"
                    >
                      <span class="text-muted-foreground">[{{ new Date(log.timestamp).toLocaleTimeString() }}]</span>
                      {{ log.message }}
                    </div>
                  </div>
                </ScrollArea>
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>
      </div>

      <div v-else class="text-muted-foreground">
        Select a scan to view details
      </div>
    </div>
  </div>
</template>
