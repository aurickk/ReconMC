<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
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
import { api } from '@/lib/api';
import type { Account } from '@/lib/types';
import { formatRelativeTime } from '@/lib/utils';
import { Plus, Pencil, Trash2, Download, Upload, RefreshCw, User, Loader2 } from 'lucide-vue-next';

const accounts = ref<Account[]>([]);
const loading = ref(true);
const isAddOpen = ref(false);
const isEditOpen = ref(false);
const isImportOpen = ref(false);
const isDeleteOpen = ref(false);
const editingAccount = ref<Account | null>(null);
const deletingAccount = ref<Account | null>(null);
const validatingId = ref<string | null>(null);
const importText = ref('');
const importLoading = ref(false);
const addLoading = ref(false);

const addForm = reactive({
  accessToken: '',
  refreshToken: '',
});

const editForm = reactive({
  username: '',
  accessToken: '',
  refreshToken: '',
  isActive: true,
  maxConcurrent: 10,
});

async function fetchAccounts() {
  loading.value = true;
  const res = await api.getAccounts();
  if (res.data) {
    accounts.value = res.data;
  }
  if (res.error) {
    toast.error('Failed to load accounts: ' + res.error);
  }
  loading.value = false;
}

function openAddDialog() {
  addForm.accessToken = '';
  addForm.refreshToken = '';
  isAddOpen.value = true;
}

async function onAddSubmit() {
  if (!addForm.accessToken.trim()) {
    toast.error('Access token is required');
    return;
  }
  
  addLoading.value = true;
  const res = await api.createAccount({
    type: 'microsoft',
    accessToken: addForm.accessToken.trim(),
    refreshToken: addForm.refreshToken.trim() || undefined,
  });
  addLoading.value = false;
  
  if (res.data) {
    toast.success(`Account validated and added: ${res.data.username || 'Unknown'}`);
    isAddOpen.value = false;
    await fetchAccounts();
  }
  if (res.error) {
    toast.error('Validation failed: ' + res.error);
  }
}

function openEditDialog(account: Account) {
  editingAccount.value = account;
  editForm.username = account.username || '';
  editForm.accessToken = '';
  editForm.refreshToken = '';
  editForm.isActive = account.isActive;
  editForm.maxConcurrent = account.maxConcurrent;
  isEditOpen.value = true;
}

async function onEditSubmit() {
  if (!editingAccount.value) return;
  
  const updateData: Parameters<typeof api.updateAccount>[1] = {
    username: editForm.username,
    isActive: editForm.isActive,
    maxConcurrent: editForm.maxConcurrent,
  };
  
  if (editForm.accessToken.trim()) {
    updateData.accessToken = editForm.accessToken.trim();
    if (editForm.refreshToken.trim()) {
      updateData.refreshToken = editForm.refreshToken.trim();
    }
  }
  
  const res = await api.updateAccount(editingAccount.value.id, updateData);
  
  if (res.data) {
    toast.success(`Account updated: ${res.data.username || 'Unknown'}`);
    isEditOpen.value = false;
    await fetchAccounts();
  }
  if (res.error) {
    toast.error('Failed to update account: ' + res.error);
  }
}

function openDeleteDialog(account: Account) {
  deletingAccount.value = account;
  isDeleteOpen.value = true;
}

async function confirmDelete() {
  if (!deletingAccount.value) return;
  const res = await api.deleteAccount(deletingAccount.value.id);
  
  if (res.error === undefined) {
    toast.success('Account deleted');
    isDeleteOpen.value = false;
    await fetchAccounts();
  }
  if (res.error) {
    toast.error('Failed to delete account: ' + res.error);
  }
}

async function validateAccount(account: Account) {
  validatingId.value = account.id;
  const res = await api.validateAccount(account.id);
  validatingId.value = null;
  
  if (res.data) {
    if (res.data.valid) {
      toast.success(`Account validated: ${res.data.username || 'Unknown'}`);
    } else {
      toast.error(`Validation failed: ${res.data.error || 'Unknown error'}`);
    }
    await fetchAccounts();
  }
  if (res.error) {
    toast.error('Validation failed: ' + res.error);
  }
}

function openImportDialog() {
  importText.value = '';
  isImportOpen.value = true;
}

async function doImport() {
  if (!importText.value.trim()) {
    toast.error('Please enter account data');
    return;
  }
  
  importLoading.value = true;
  const lines = importText.value.trim().split('\n');
  const accountsToImport = lines.map(line => {
    const parts = line.split(':');
    const accessToken = parts[0]?.trim();
    const refreshToken = parts[1]?.trim();
    return { type: 'microsoft' as const, accessToken, refreshToken };
  }).filter(a => a.accessToken);
  
  if (accountsToImport.length === 0) {
    toast.error('No valid accounts found. Use format: accessToken or accessToken:refreshToken');
    importLoading.value = false;
    return;
  }
  
  const res = await api.importAccounts(accountsToImport);
  importLoading.value = false;
  
  if (res.data) {
    toast.success(`Imported ${res.data.successful} accounts (${res.data.failed} failed validation)`);
    isImportOpen.value = false;
    await fetchAccounts();
  }
  if (res.error) {
    toast.error('Import failed: ' + res.error);
  }
}

async function doExport() {
  const res = await api.exportAccounts();
  
  if (res.data) {
    const json = JSON.stringify(res.data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reconmc-accounts-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${res.data.length} accounts`);
  }
  if (res.error) {
    toast.error('Export failed: ' + res.error);
  }
}

function getStatusBadge(account: Account): { class: string; label: string } {
  if (!account.isValid) {
    return { class: 'bg-red-500/10 text-red-600 border-red-500/20', label: 'Invalid' };
  }
  if (!account.isActive) {
    return { class: 'bg-gray-500/10 text-gray-600 border-gray-500/20', label: 'Disabled' };
  }
  return { class: 'bg-green-500/10 text-green-600 border-green-500/20', label: 'Valid' };
}

onMounted(fetchAccounts);
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-3xl font-bold tracking-tight">Microsoft Accounts</h2>
        <p class="text-muted-foreground">
          Microsoft accounts for scanning (auto-validated on add)
        </p>
      </div>
      <div class="flex gap-2">
        <Button variant="outline" @click="openImportDialog">
          <Upload class="mr-2 h-4 w-4" />
          Import
        </Button>
        <Button variant="outline" @click="doExport" :disabled="accounts.length === 0">
          <Download class="mr-2 h-4 w-4" />
          Export
        </Button>
        <Dialog v-model:open="isAddOpen">
          <DialogTrigger as-child>
            <Button @click="openAddDialog">
              <Plus class="mr-2 h-4 w-4" />
              Add Account
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Microsoft Account</DialogTitle>
              <DialogDescription>
                Add a Microsoft account — it will be validated automatically
              </DialogDescription>
            </DialogHeader>
            <form @submit.prevent="onAddSubmit" class="space-y-4">
              <div class="space-y-2">
                <Label for="add-token">Access Token *</Label>
                <Input id="add-token" v-model="addForm.accessToken" type="password" placeholder="Minecraft access token" />
                <p class="text-xs text-muted-foreground">The Minecraft access/session token</p>
              </div>
              <div class="space-y-2">
                <Label for="add-refresh">Refresh Token (optional)</Label>
                <Input id="add-refresh" v-model="addForm.refreshToken" type="password" placeholder="Microsoft refresh token" />
                <p class="text-xs text-muted-foreground">Allows automatic token refresh</p>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" @click="isAddOpen = false">Cancel</Button>
                <Button type="submit" :disabled="addLoading">
                  <Loader2 v-if="addLoading" class="mr-2 h-4 w-4 animate-spin" />
                  Validate & Add
                </Button>
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

        <div v-else-if="accounts.length === 0" class="p-8 text-center">
          <User class="mx-auto h-12 w-12 text-muted-foreground" />
          <h3 class="mt-4 text-lg font-semibold">No accounts configured</h3>
          <p class="mt-2 text-muted-foreground">Add Microsoft accounts to scan online-mode servers.</p>
          <Button class="mt-4" @click="openAddDialog">
            <Plus class="mr-2 h-4 w-4" />
            Add Account
          </Button>
        </div>

        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead>Username</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Usage</TableHead>
              <TableHead>Last Validated</TableHead>
              <TableHead class="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="account in accounts" :key="account.id">
              <TableCell class="font-medium">{{ account.username || '—' }}</TableCell>
              <TableCell>
                <Badge variant="outline" :class="getStatusBadge(account).class">
                  {{ getStatusBadge(account).label }}
                </Badge>
              </TableCell>
              <TableCell>{{ account.currentUsage }} / {{ account.maxConcurrent }}</TableCell>
              <TableCell class="text-muted-foreground">{{ formatRelativeTime(account.lastValidatedAt) }}</TableCell>
              <TableCell class="text-right">
                <div class="flex justify-end gap-1">
                  <Button variant="ghost" size="icon" @click="validateAccount(account)" :disabled="validatingId === account.id" title="Re-validate">
                    <Loader2 v-if="validatingId === account.id" class="h-4 w-4 animate-spin" />
                    <RefreshCw v-else class="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" @click="openEditDialog(account)" title="Edit">
                    <Pencil class="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" @click="openDeleteDialog(account)" title="Delete">
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
          <DialogTitle>Edit Account</DialogTitle>
          <DialogDescription>
            Update account settings
          </DialogDescription>
        </DialogHeader>
        <form @submit.prevent="onEditSubmit" class="space-y-4">
          <div class="space-y-2">
            <Label for="edit-username">Username</Label>
            <Input id="edit-username" v-model="editForm.username" />
          </div>
          <div class="space-y-2">
            <Label for="edit-token">New Access Token (optional)</Label>
            <Input id="edit-token" v-model="editForm.accessToken" type="password" placeholder="Leave blank to keep current" />
          </div>
          <div class="space-y-2">
            <Label for="edit-refresh">New Refresh Token (optional)</Label>
            <Input id="edit-refresh" v-model="editForm.refreshToken" type="password" placeholder="Leave blank to keep current" />
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
          <DialogTitle>Import Accounts</DialogTitle>
          <DialogDescription>
            Paste Microsoft account tokens, one per line. Accounts are validated on import.
          </DialogDescription>
        </DialogHeader>
        <div class="space-y-4">
          <Textarea v-model="importText" rows="8" placeholder="accessToken&#10;accessToken:refreshToken&#10;&#10;Example:&#10;eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...&#10;eyJhbGci...:M.C529_BAY.CSRF.Token..." />
          <p class="text-sm text-muted-foreground">
            Format: <code class="bg-muted px-1 rounded">accessToken</code> (required) or 
            <code class="bg-muted px-1 rounded">accessToken:refreshToken</code>
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="isImportOpen = false">Cancel</Button>
          <Button @click="doImport" :disabled="importLoading">
            <Loader2 v-if="importLoading" class="mr-2 h-4 w-4 animate-spin" />
            Import & Validate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <AlertDialog v-model:open="isDeleteOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Account</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete "{{ deletingAccount?.username || 'this account' }}"? This action cannot be undone.
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
