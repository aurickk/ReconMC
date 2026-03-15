<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { toast } from 'vue-sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
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
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { api } from '@/lib/api';
import type { Session } from '@/lib/types';
import { Upload, Trash2, KeyRound, Loader2 } from 'lucide-vue-next';

const sessions = ref<Session[]>([]);
const loading = ref(true);
const isImportOpen = ref(false);
const isDeleteOpen = ref(false);
const deletingSession = ref<Session | null>(null);
const importText = ref('');
const importMaxConcurrent = ref(3);
const importLoading = ref(false);

// Computed pool stats
const totalSessions = computed(() => sessions.value.length);
const inUseSessions = computed(() => sessions.value.filter(s => s.currentUsage > 0).length);
const availableSessions = computed(() => sessions.value.filter(s => s.currentUsage < s.maxConcurrent).length);

async function fetchSessions() {
  loading.value = true;
  const res = await api.getSessions();
  if (res.data) {
    sessions.value = res.data;
  }
  if (res.error) {
    toast.error('Failed to load sessions: ' + res.error);
  }
  loading.value = false;
}

function openImportDialog() {
  importText.value = '';
  importMaxConcurrent.value = 3;
  isImportOpen.value = true;
}

async function doImport() {
  if (!importText.value.trim()) {
    toast.error('Please enter session tokens');
    return;
  }

  importLoading.value = true;
  const tokens = importText.value
    .trim()
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  if (tokens.length === 0) {
    toast.error('No valid tokens found. Paste one access token per line.');
    importLoading.value = false;
    return;
  }

  const res = await api.importSessions(tokens);
  importLoading.value = false;

  if (res.data) {
    const { imported, rejected, errors } = res.data;
    if (imported > 0) {
      toast.success(`Imported ${imported} session${imported !== 1 ? 's' : ''}${rejected > 0 ? `, ${rejected} rejected` : ''}`);
    } else if (rejected > 0) {
      toast.error(`All ${rejected} token${rejected !== 1 ? 's' : ''} were rejected`);
    }
    if (errors && errors.length > 0) {
      const errorMessages = errors
        .filter(e => e.error)
        .slice(0, 3)
        .map(e => `Token ${e.index + 1}: ${e.error}`)
        .join('\n');
      if (errorMessages) {
        toast.error(errorMessages);
      }
    }
    isImportOpen.value = false;
    await fetchSessions();
  }
  if (res.error) {
    toast.error('Import failed: ' + res.error);
  }
}

function openDeleteDialog(session: Session) {
  deletingSession.value = session;
  isDeleteOpen.value = true;
}

async function confirmDelete() {
  if (!deletingSession.value) return;
  const res = await api.deleteSession(deletingSession.value.id);

  if (res.error === undefined) {
    toast.success('Session deleted');
    isDeleteOpen.value = false;
    await fetchSessions();
  }
  if (res.error) {
    toast.error('Failed to delete session: ' + res.error);
  }
}

function getStatusBadge(session: Session): { variant: 'default' | 'secondary' | 'outline'; label: string } {
  if (session.currentUsage > 0) {
    return { variant: 'default', label: 'In Use' };
  }
  return { variant: 'outline', label: 'Available' };
}

onMounted(fetchSessions);
</script>

<template>
  <div class="space-y-6">
    <!-- Pool Summary Stats -->
    <div class="grid gap-4 md:grid-cols-3">
      <Card>
        <CardContent class="p-6">
          <div class="text-sm font-medium text-muted-foreground">Total Sessions</div>
          <div class="text-3xl font-bold mt-1">
            <Skeleton v-if="loading" class="h-9 w-16" />
            <span v-else>{{ totalSessions }}</span>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent class="p-6">
          <div class="text-sm font-medium text-muted-foreground">In Use</div>
          <div class="text-3xl font-bold mt-1">
            <Skeleton v-if="loading" class="h-9 w-16" />
            <span v-else>{{ inUseSessions }}</span>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent class="p-6">
          <div class="text-sm font-medium text-muted-foreground">Available</div>
          <div class="text-3xl font-bold mt-1">
            <Skeleton v-if="loading" class="h-9 w-16" />
            <span v-else>{{ availableSessions }}</span>
          </div>
        </CardContent>
      </Card>
    </div>

    <!-- Actions Bar -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-3xl font-bold tracking-tight">Sessions</h2>
        <p class="text-muted-foreground">
          Session tokens for scanning online-mode servers
        </p>
      </div>
      <div class="flex gap-2">
        <Button @click="openImportDialog">
          <Upload class="mr-2 h-4 w-4" />
          Import Sessions
        </Button>
      </div>
    </div>

    <!-- Token List Table -->
    <Card>
      <CardContent class="p-0">
        <div v-if="loading" class="p-4 space-y-3">
          <Skeleton class="h-10 w-full" />
          <Skeleton class="h-10 w-full" />
          <Skeleton class="h-10 w-full" />
        </div>

        <div v-else-if="sessions.length === 0" class="p-8 text-center">
          <KeyRound class="mx-auto h-12 w-12 text-muted-foreground" />
          <h3 class="mt-4 text-lg font-semibold">No sessions found</h3>
          <p class="mt-2 text-muted-foreground">Import session tokens to get started.</p>
          <Button class="mt-4" @click="openImportDialog">
            <Upload class="mr-2 h-4 w-4" />
            Import Sessions
          </Button>
        </div>

        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead>Username</TableHead>
              <TableHead>Status</TableHead>
              <TableHead class="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="session in sessions" :key="session.id">
              <TableCell class="font-medium">{{ session.username ?? 'Unknown' }}</TableCell>
              <TableCell>
                <Badge :variant="getStatusBadge(session).variant">
                  {{ getStatusBadge(session).label }}
                </Badge>
              </TableCell>
              <TableCell class="text-right">
                <Button variant="ghost" size="icon" @click="openDeleteDialog(session)" title="Delete">
                  <Trash2 class="h-4 w-4 text-destructive" />
                </Button>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>

    <!-- Import Dialog -->
    <Dialog v-model:open="isImportOpen">
      <DialogContent class="max-w-lg">
        <DialogHeader>
          <DialogTitle>Import Session Tokens</DialogTitle>
          <DialogDescription>
            Paste Minecraft access tokens, one per line. Each token will be validated before import.
          </DialogDescription>
        </DialogHeader>
        <div class="space-y-4">
          <div class="space-y-2">
            <Label for="import-tokens">Access Tokens</Label>
            <Textarea
              id="import-tokens"
              v-model="importText"
              rows="8"
              placeholder="eyJhbGciOiJIUzI1NiIs...&#10;eyJhbGciOiJIUzI1NiIs...&#10;eyJhbGciOiJIUzI1NiIs..."
            />
            <p class="text-sm text-muted-foreground">
              One access token per line. Tokens are validated against Minecraft services on import.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="isImportOpen = false">Cancel</Button>
          <Button @click="doImport" :disabled="importLoading">
            <Loader2 v-if="importLoading" class="mr-2 h-4 w-4 animate-spin" />
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Delete Confirmation -->
    <AlertDialog v-model:open="isDeleteOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Session</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete the session for "{{ deletingSession?.username ?? 'Unknown' }}"? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction @click="confirmDelete" class="bg-destructive text-destructive-foreground hover:bg-destructive/90">
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
