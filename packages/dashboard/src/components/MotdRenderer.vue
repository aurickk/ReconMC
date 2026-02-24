<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from 'vue';

const props = defineProps<{
  motd: string | null;
}>();

const COLORS: Record<string, string> = {
  '0': '#000000',
  '1': '#0000AA',
  '2': '#00AA00',
  '3': '#00AAAA',
  '4': '#AA0000',
  '5': '#AA00AA',
  '6': '#FFAA00',
  '7': '#AAAAAA',
  '8': '#555555',
  '9': '#5555FF',
  'a': '#55FF55',
  'b': '#55FFFF',
  'c': '#FF5555',
  'd': '#FF55FF',
  'e': '#FFFF55',
  'f': '#FFFFFF',
};

const OBFUSCATE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';

interface ParsedSegment {
  text: string;
  color: string | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  obfuscated: boolean;
}

function parseMotd(motd: string): ParsedSegment[][] {
  const lines: ParsedSegment[][] = [];
  const textLines = motd.split('\n');
  
  for (const line of textLines) {
    const segments: ParsedSegment[] = [];
    let currentSegment: ParsedSegment = {
      text: '',
      color: null,
      bold: false,
      italic: false,
      underline: false,
      strikethrough: false,
      obfuscated: false,
    };
    
    let i = 0;
    while (i < line.length) {
      if (line[i] === '\u00A7' && i + 1 < line.length) {
        const code = line[i + 1].toLowerCase();
        
        if (currentSegment.text) {
          segments.push({ ...currentSegment });
          currentSegment = { ...currentSegment, text: '' };
        }
        
        if (COLORS[code]) {
          currentSegment.color = COLORS[code];
        } else if (code === 'l') {
          currentSegment.bold = true;
        } else if (code === 'o') {
          currentSegment.italic = true;
        } else if (code === 'n') {
          currentSegment.underline = true;
        } else if (code === 'm') {
          currentSegment.strikethrough = true;
        } else if (code === 'k') {
          currentSegment.obfuscated = true;
        } else if (code === 'r') {
          currentSegment = {
            text: '',
            color: null,
            bold: false,
            italic: false,
            underline: false,
            strikethrough: false,
            obfuscated: false,
          };
        }
        
        i += 2;
      } else {
        currentSegment.text += line[i];
        i++;
      }
    }
    
    if (currentSegment.text) {
      segments.push(currentSegment);
    }
    
    lines.push(segments);
  }
  
  return lines;
}

const parsedLines = computed(() => {
  if (!props.motd) return [];
  return parseMotd(props.motd);
});

const hasObfuscated = computed(() => {
  return parsedLines.value.some(line => 
    line.some(seg => seg.obfuscated && seg.text.length > 0)
  );
});

const obfuscatedTexts = ref<Map<string, string>>(new Map());
let animationInterval: ReturnType<typeof setInterval> | null = null;

function randomizeText(text: string): string {
  return text.split('').map(() => 
    OBFUSCATE_CHARS[Math.floor(Math.random() * OBFUSCATE_CHARS.length)]
  ).join('');
}

function updateObfuscatedTexts() {
  const newTexts = new Map<string, string>();
  
  parsedLines.value.forEach((line, lineIdx) => {
    line.forEach((seg, segIdx) => {
      if (seg.obfuscated && seg.text) {
        const key = `${lineIdx}-${segIdx}`;
        newTexts.set(key, randomizeText(seg.text));
      }
    });
  });
  
  obfuscatedTexts.value = newTexts;
}

watch(() => props.motd, () => {
  updateObfuscatedTexts();
}, { immediate: true });

onMounted(() => {
  if (hasObfuscated.value) {
    animationInterval = setInterval(updateObfuscatedTexts, 80);
  }
});

onUnmounted(() => {
  if (animationInterval) {
    clearInterval(animationInterval);
  }
});

watch(hasObfuscated, ( newVal) => {
  if (newVal && !animationInterval) {
    animationInterval = setInterval(updateObfuscatedTexts, 80);
  } else if (!newVal && animationInterval) {
    clearInterval(animationInterval);
    animationInterval = null;
  }
});

function getSegmentStyle(segment: ParsedSegment): Record<string, string> {
  const style: Record<string, string> = {};
  if (segment.color) style.color = segment.color;
  return style;
}

function getSegmentClasses(segment: ParsedSegment): string[] {
  const classes: string[] = [];
  if (segment.bold) classes.push('font-bold');
  if (segment.italic) classes.push('italic');
  if (segment.underline) classes.push('underline');
  if (segment.strikethrough) classes.push('line-through');
  return classes;
}

function getDisplayText(segment: ParsedSegment, lineIdx: number, segIdx: number): string {
  if (segment.obfuscated) {
    const key = `${lineIdx}-${segIdx}`;
    return obfuscatedTexts.value.get(key) || segment.text;
  }
  return segment.text;
}
</script>

<template>
  <div v-if="motd" class="font-mono text-sm leading-relaxed whitespace-pre-wrap">
    <div v-for="(line, lineIdx) in parsedLines" :key="lineIdx">
      <span
        v-for="(segment, segIdx) in line"
        :key="segIdx"
        :style="getSegmentStyle(segment)"
        :class="getSegmentClasses(segment)"
      >
        {{ getDisplayText(segment, lineIdx, segIdx) }}
      </span>
    </div>
  </div>
  <span v-else class="text-muted-foreground">No MOTD</span>
</template>
