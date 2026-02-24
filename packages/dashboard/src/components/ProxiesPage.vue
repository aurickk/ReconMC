<script setup lang="ts">
import { ref, onMounted, reactive } from 'vue';
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
  DialogTrigger,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import type { Proxy } from '@/lib/types';
import { Plus, Pencil, Trash2, Download, Upload, Shield, Loader2 } from 'lucide-vue-next';

const proxies = ref<Proxy[]>([]);
const loading = ref(true);
const isAddOpen = ref(false);
const isEditOpen = ref(false);
const isImportOpen = ref(false);
const isDeleteOpen = ref(false);
const editingProxy = ref<Proxy | null>(null);
const deletingProxy = ref<Proxy | null>(null);
const importText = ref('');
const importLoading = ref(false);

const addForm = reactive({
  host: '',
  port: 1080,
  protocol: 'socks5' as 'socks4' | 'socks5',
  username: '',
  password: '',
});

const editForm = reactive({
  host: '',
  port: 1080,
  username: '',
  password: '',
  isActive: true,
  maxConcurrent: 10,
});

async function fetchProxies() {
  loading.value = true;
  const res = await api.getProxies();
  if (res.data) {
    proxies.value = res.data;
  }
  if (res.error) {
    toast.error('Failed to load proxies: ' + res.error);
  }
  loading.value = false;
}

function openAddDialog() {
  addForm.host = '';
  addForm.port = 1080;
  addForm.protocol = 'socks5';
  addForm.username = '';
  addForm.password = '';
  isAddOpen.value = true;
}

async function onAddSubmit() {
  if (!addForm.host) {
    toast.error('Host is required');
    return;
  }
  
  const res = await api.createProxy({
    host: addForm.host,
    port: addForm.port,
    protocol: addForm.protocol,
    username: addForm.username || undefined,
    password: addForm.password || undefined,
  });
  
  if (res.data) {
    toast.success(`Proxy added: ${res.data.host}:${res.data.port}`);
    isAddOpen.value = false;
    await fetchProxies();
  }
  if (res.error) {
    toast.error('Failed to add proxy: ' + res.error);
  }
}

function openEditDialog(proxy: Proxy) {
  editingProxy.value = proxy;
  editForm.host = proxy.host;
  editForm.port = proxy.port;
  editForm.username = proxy.username || '';
  editForm.password = '';
  editForm.isActive = proxy.isActive;
  editForm.maxConcurrent = proxy.maxConcurrent;
  isEditOpen.value = true;
}

async function onEditSubmit() {
  if (!editingProxy.value) return;
  
  const updateData: Parameters<typeof api.updateProxy>[1] = {
    host: editForm.host,
    port: editForm.port,
    username: editForm.username || undefined,
    password: editForm.password || undefined,
    isActive: editForm.isActive,
    maxConcurrent: editForm.maxConcurrent,
  };
  
  const res = await api.updateProxy(editingProxy.value.id, updateData);
  
  if (res.data) {
    toast.success(`Proxy updated: ${res.data.host}:${res.data.port}`);
    isEditOpen.value = false;
    await fetchProxies();
  }
  if (res.error) {
    toast.error('Failed to update proxy: ' + res.error);
  }
}

function openDeleteDialog(proxy: Proxy) {
  deletingProxy.value = proxy;
  isDeleteOpen.value = true;
}

async function confirmDelete() {
  if (!deletingProxy.value) return;
  const res = await api.deleteProxy(deletingProxy.value.id);
  
  if (res.error === undefined) {
    toast.success('Proxy deleted');
    isDeleteOpen.value = false;
    await fetchProxies();
  }
  if (res.error) {
    toast.error('Failed to delete proxy: ' + res.error);
  }
}

function openImportDialog() {
  importText.value = '';
  isImportOpen.value = true;
}

async function doImport() {
  if (!importText.value.trim()) {
    toast.error('Please enter proxy data');
    return;
  }
  
  importLoading.value = true;
  const res = await api.importProxies(importText.value);
  importLoading.value = false;
  
  if (res.data) {
    toast.success(`Imported ${res.data.imported} proxies`);
    isImportOpen.value = false;
    await fetchProxies();
  }
  if (res.error) {
    toast.error('Import failed: ' + res.error);
  }
}

async function doExport() {
  const res = await api.exportProxies();
  
  if (res.data) {
    const json = JSON.stringify(res.data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reconmc-proxies-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${res.data.length} proxies`);
  }
  if (res.error) {
    toast.error('Export failed: ' + res.error);
  }
}

function formatDate(date: string | null): string {
  if (!date) return '—';
  return new Date(date).toLocaleDateString();
}

onMounted(fetchProxies);
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-3xl font-bold tracking-tight">Proxies</h2>
        <p class="text-muted-foreground">
          Manage SOCKS proxies for bot connections
        </p>
      </div>
      <div class="flex gap-2">
        <Button variant="outline" @click="openImportDialog">
          <Upload class="mr-2 h-4 w-4" />
          Import
        </Button>
        <Button variant="outline" @click="doExport" :disabled="proxies.length === 0">
          <Download class="mr-2 h-4 w-4" />
          Export
        </Button>
        <Dialog v-model:open="isAddOpen">
          <DialogTrigger as-child>
            <Button @click="openAddDialog">
              <Plus class="mr-2 h-4 w-4" />
              Add Proxy
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Proxy</DialogTitle>
              <DialogDescription>
                Add a new SOCKS proxy
              </DialogDescription>
            </DialogHeader>
            <form @submit.prevent="onAddSubmit" class="space-y-4">
              <div class="grid grid-cols-3 gap-4">
                <div class="col-span-2 space-y-2">
                  <Label for="add-host">Host</Label>
                  <Input id="add-host" v-model="addForm.host" placeholder="proxy.example.com" />
                </div>
                <div class="space-y-2">
                  <Label for="add-port">Port</Label>
                  <Input id="add-port" type="number" v-model.number="addForm.port" />
                </div>
              </div>
              <div class="space-y-2">
                <Label for="add-protocol">Protocol</Label>
                <Select v-model="addForm.protocol">
                  <SelectTrigger>
                    <SelectValue placeholder="Select protocol" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="socks5">SOCKS5</SelectItem>
                    <SelectItem value="socks4">SOCKS4</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="grid grid-cols-2 gap-4">
                <div class="space-y-2">
                  <Label for="add-username">Username (optional)</Label>
                  <Input id="add-username" v-model="addForm.username" />
                </div>
                <div class="space-y-2">
                  <Label for="add-password">Password (optional)</Label>
                  <Input id="add-password" v-model="addForm.password" type="password" />
                </div>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" @click="isAddOpen = false">Cancel</Button>
                <Button type="submit">Add Proxy</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </div>

    <Card>
      <CardContent class="p-0">
        <div v-if="loading" class="p-4 space-y-3">
          <Skeleton class="h-10 w-full" />
          <Skeleton class="h-10 w-full" />
          <Skeleton class="h-10 w-full" />
        </div>

        <div v-else-if="proxies.length === 0" class="p-8 text-center">
          <Shield class="mx-auto h-12 w-12 text-muted-foreground" />
          <h3 class="mt-4 text-lg font-semibold">No proxies configured</h3>
          <p class="mt-2 text-muted-foreground">Add proxies for bot connections.</p>
          <Button class="mt-4" @click="openAddDialog">
            <Plus class="mr-2 h-4 w-4" />
            Add Proxy
          </Button>
        </div>

        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead>Host</TableHead>
              <TableHead>Port</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Auth</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Usage</TableHead>
              <TableHead>Last Used</TableHead>
              <TableHead class="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="proxy in proxies" :key="proxy.id">
              <TableCell class="font-medium">{{ proxy.host }}</TableCell>
              <TableCell>{{ proxy.port }}</TableCell>
              <TableCell>
                <Badge variant="outline" :class="proxy.protocol === 'socks5' ? 'bg-blue-500/10 text-blue-600' : 'bg-purple-500/10 text-purple-600'">
                  {{ proxy.protocol.toUpperCase() }}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge v-if="proxy.username" variant="outline" class="bg-green-500/10 text-green-600">
                  Yes
                </Badge>
                <span v-else class="text-muted-foreground">No</span>
              </TableCell>
              <TableCell>
                <Badge variant="outline" :class="proxy.isActive ? 'bg-green-500/10 text-green-600' : 'bg-gray-500/10 text-gray-600'">
                  {{ proxy.isActive ? 'Active' : 'Disabled' }}
                </Badge>
              </TableCell>
              <TableCell>{{ proxy.currentUsage }} / {{ proxy.maxConcurrent }}</TableCell>
              <TableCell class="text-muted-foreground">{{ formatDate(proxy.lastUsedAt) }}</TableCell>
              <TableCell class="text-right">
                <div class="flex justify-end gap-1">
                  <Button variant="ghost" size="icon" @click="openEditDialog(proxy)">
                    <Pencil class="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" @click="openDeleteDialog(proxy)">
                    <Trash2 class="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>

    <Dialog v-model:open="isEditOpen">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Proxy</DialogTitle>
          <DialogDescription>
            Update proxy settings
          </DialogDescription>
        </DialogHeader>
        <form @submit.prevent="onEditSubmit" class="space-y-4">
          <div class="grid grid-cols-3 gap-4">
            <div class="col-span-2 space-y-2">
              <Label for="edit-host">Host</Label>
              <Input id="edit-host" v-model="editForm.host" />
            </div>
            <div class="space-y-2">
              <Label for="edit-port">Port</Label>
              <Input id="edit-port" type="number" v-model.number="editForm.port" />
            </div>
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-2">
              <Label for="edit-username">Username</Label>
              <Input id="edit-username" v-model="editForm.username" />
            </div>
            <div class="space-y-2">
              <Label for="edit-password">New Password</Label>
              <Input id="edit-password" v-model="editForm.password" type="password" placeholder="Leave blank to keep" />
            </div>
          </div>
          <div class="space-y-2">
            <Label for="edit-max">Max Concurrent</Label>
            <Input id="edit-max" type="number" v-model.number="editForm.maxConcurrent" min="1" max="100" />
          </div>
          <div class="flex items-center gap-2">
            <input type="checkbox" id="edit-active" v-model="editForm.isActive" class="rounded" />
            <Label for="edit-active">Active</Label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" @click="isEditOpen = false">Cancel</Button>
            <Button type="submit">Save Changes</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="isImportOpen">
      <DialogContent class="max-w-lg">
        <DialogHeader>
          <DialogTitle>Import Proxies</DialogTitle>
          <DialogDescription>
            Paste proxies in Webshare format, one per line. All proxies are added as SOCKS5.
          </DialogDescription>
        </DialogHeader>
        <div class="space-y-4">
          <Textarea v-model="importText" rows="8" placeholder="proxy.example.com:1080&#10;proxy.example.com:1080:username:password&#10;&#10;Example:&#10;185.199.228.220:7373&#10;185.199.229.108:7373:user123:pass456" />
          <p class="text-sm text-muted-foreground">
            Format: <code class="bg-muted px-1 rounded">host:port</code> or 
            <code class="bg-muted px-1 rounded">host:port:username:password</code>
          </p>
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

    <AlertDialog v-model:open="isDeleteOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Proxy</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete "{{ deletingProxy?.host }}:{{ deletingProxy?.port }}"? This action cannot be undone.
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
