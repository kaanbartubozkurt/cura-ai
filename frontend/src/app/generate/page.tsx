'use client';

import LibraryImage from '@/components/LibraryImage';
import ProgressiveImage from '@/components/ProgressiveImage';
import { useImagePixels } from '@/hooks/useImagePixels';

import { useState, useEffect, useRef, useMemo, Suspense } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { generationApi, settingsApi, billingApi, imagesApi } from '@/lib/api';
import { Loader2, X, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { trackFunnelStep } from '@/lib/observability';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import Stage from '@/components/tools/Stage';
import SheetButton from '@/components/tools/SheetButton';
import Composer from '@/components/tools/Composer';
import Notice from '@/components/tools/Notice';
import { AppendOnlyGrid, Segmented } from '@/components/ImageGrid';
import { useAuth } from '@/contexts/AuthContext';
import type { CreateChoices } from '@/lib/api';
import type { GeneratedImage } from '@/types';
import { useModelCatalog } from '@/hooks/useModelCatalog';
import { Slider } from '@/components/Slider';
import { formatDate, parseUTC } from '@/lib/utils';

export default function GeneratePage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-32"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}>
      <GeneratePageInner />
    </Suspense>
  );
}

function generationPreview(image: GeneratedImage) {
  const uri = image.thumbnail_uri_medium || image.thumbnail_uri_small;
  return uri ? generationApi.getThumbnailUrl(uri.split('/').pop()!) : generationApi.getImageUrl(image.id);
}

function CreateThumbnail({ image, density, onPreviewLoaded }: {
  image: GeneratedImage;
  density: 'S' | 'M' | 'L';
  onPreviewLoaded: (source: string, url: string) => void;
}) {
  const { host, pixels } = useImagePixels(image.width, image.height);
  const uri = pixels <= 400
    ? image.library_thumbnail_uri_medium || image.library_thumbnail_uri_large
    : image.library_thumbnail_uri_large;
  const high = uri ? imagesApi.getThumbnailUrl(uri.split('/').pop()!)
    : !image.library_image_id && pixels > 400 && density !== 'S' ? generationApi.getImageUrl(image.id) : undefined;
  return (
    <span ref={host} className="block h-full w-full">
      <ProgressiveImage
        src={generationPreview(image)}
        highSrc={pixels > 0 ? high : undefined}
        alt={image.prompt}
        loading="lazy"
        className="h-full w-full object-cover"
        onPreviewLoaded={onPreviewLoaded}
      />
    </span>
  );
}

function GeneratePageInner() {
  const previews = useRef(new Map<number, { source: string; url: string }>());
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const [references, setReferences] = useState<Array<{ id: number; url: string }>>([]);

  useEffect(() => {
    const ids = (searchParams.get('sources') || '').split(',').map(Number).filter(id => Number.isInteger(id) && id > 0);
    let active = true;
    Promise.all(ids.map(async id => {
      try {
        const image = await imagesApi.get(id);
        const thumbnail = image.thumbnail_uri_medium || image.thumbnail_uri_small;
        return { id, url: thumbnail ? imagesApi.getThumbnailUrl(thumbnail.split('/').pop()!) : imagesApi.getImageUrl(image.object_key.split('/').pop()!) };
      } catch {
        toast.error(`Could not load selected image ${id}`);
        return null;
      }
    })).then(items => {
      if (active) setReferences(items.filter((item): item is NonNullable<typeof item> => item !== null));
    });
    return () => { active = false; };
  }, [searchParams]);

  // Form state
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [notice, setNotice] = useState('');
  const [baseModel, setBaseModel] = useState('');
  const [quality, setQuality] = useState('');
  const [loraSelections, setLoraSelections] = useState<Array<{ id: number; scale: number }>>([]);
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [steps, setSteps] = useState(28);
  const [guidance, setGuidance] = useState(0);
  const [seed, setSeed] = useState<string>('');
  const [numImages, setNumImages] = useState(1);
  const [resolution, setResolution] = useState('1K');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [safetyTolerance, setSafetyTolerance] = useState('4');
  const [enableWebSearch, setEnableWebSearch] = useState(false);
  const [imageSizePreset, setImageSizePreset] = useState('landscape_4_3');
  const [autoExpand, setAutoExpand] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  const { data: catalog } = useModelCatalog();
  const BASE_MODELS = useMemo(() => (catalog?.generation ?? []).map(m => ({ value: m.key, label: m.label, defaultGuidance: m.params.steps_guidance?.guidance?.default ?? 0, hasLora: m.supports_lora, hasStepsGuidance: !!m.params.steps_guidance, hasWidthHeight: false, usesResolutionAspect: !!(m.params.resolution || m.params.aspect_ratio), hasSafetyTolerance: !!m.params.safety_tolerance, hasWebSearch: !!m.params.enable_web_search, hasImageSizePreset: !!m.params.image_size, hasNegativePrompt: !!m.params.negative_prompt, maxSafetyLevel: 6, maxImages: m.max_num_images || 1 })), [catalog]);
  const modelCaps = BASE_MODELS.find(m => m.value === baseModel) ?? { hasLora: false, hasStepsGuidance: false, hasWidthHeight: false, usesResolutionAspect: false, hasSafetyTolerance: false, hasWebSearch: false, hasImageSizePreset: false, hasNegativePrompt: false, maxSafetyLevel: 6, maxImages: 1 };
  const model = catalog?.generation.find(m => m.key === baseModel);
  const spec = useMemo(() => model?.params ?? {}, [model]);
  const RESOLUTIONS = (spec.resolution?.options ?? []).map(value => ({ value, label: value }));
  const ASPECT_RATIOS = (spec.aspect_ratio?.options ?? []).map(value => ({ value, label: value }));
  const SAFETY_LEVELS = (spec.safety_tolerance?.options ?? []).map(value => ({ value, label: value, level: Number(value) }));
  const IMAGE_SIZE_PRESETS = [...(spec.image_size?.options ?? []), ...(spec.image_size?.custom_size ? ['custom'] : [])].map(value => ({ value, label: value.replaceAll('_', ' '), ratio: '1:1' }));
  // Restore only choices supported by the current catalog.

  const { user } = useAuth();
  const { data: savedChoices } = useQuery({
    queryKey: ['create-choices', user?.id],
    queryFn: settingsApi.getCreateChoices,
    enabled: !!user,
    staleTime: Infinity,
  });
  const choices = useRef<Record<string, CreateChoices>>({});
  const initializedModel = useRef('');
  const appliedChoices = useRef('');
  useEffect(() => {
    if (savedChoices) choices.current = savedChoices;
  }, [savedChoices]);
  useEffect(() => {
    if (!model || !savedChoices || initializedModel.current === model.key) return;
    const saved = choices.current[model.key] ?? {};
    const dropped: string[] = [];
    const previous = choices.current[initializedModel.current];
    if (previous && !choices.current[model.key]) {
      for (const [key, value] of Object.entries(previous)) {
        const param = model.params[key];
        if (['resolution', 'aspect_ratio', 'image_size', 'quality', 'safety_tolerance'].includes(key)
          && !(param?.options?.includes(String(value)) || (value === 'custom' && param?.custom_size))) {
          dropped.push(key.replaceAll('_', ' '));
        }
      }
    }
    for (const key of Object.keys(saved)) {
      if (!['num_images', 'auto_expand', 'steps', 'guidance', 'width', 'height'].includes(key) && !model.params[key]) {
        dropped.push(key.replaceAll('_', ' '));
      }
    }
    const option = (key: string) => {
      const param = model.params[key];
      const value = saved[key];
      if (typeof value === 'string' && (param?.options?.includes(value) || (value === 'custom' && param?.custom_size))) return value;
      if (value !== undefined) dropped.push(key.replaceAll('_', ' '));
      return param?.default ?? '';
    };
    setResolution(option('resolution'));
    setAspectRatio(option('aspect_ratio'));
    setImageSizePreset(option('image_size'));
    setQuality(option('quality'));
    setSafetyTolerance(option('safety_tolerance'));
    const bound = (key: 'steps' | 'guidance') => {
      const bounds = model.params.steps_guidance?.[key];
      const value = saved[key];
      const result = bounds ? Math.max(bounds.minimum, Math.min(bounds.maximum, typeof value === 'number' ? value : bounds.default)) : 0;
      if (value !== undefined && value !== result) dropped.push(key);
      return result;
    };
    setSteps(bound('steps'));
    setGuidance(bound('guidance'));
    const count = typeof saved.num_images === 'number' ? Math.max(1, Math.min(model.max_num_images, Math.floor(saved.num_images))) : 1;
    if (saved.num_images !== undefined && count !== saved.num_images) dropped.push('results');
    setNumImages(count);
    setWidth(typeof saved.width === 'number' ? Math.max(256, Math.min(2048, saved.width)) : 1024);
    setHeight(typeof saved.height === 'number' ? Math.max(256, Math.min(2048, saved.height)) : 1024);
    setEnableWebSearch(!!model.params.enable_web_search && saved.enable_web_search === true);
    setNegativePrompt(model.params.negative_prompt && typeof saved.negative_prompt === 'string' ? saved.negative_prompt : '');
    setAutoExpand(saved.auto_expand === true);
    setNotice(dropped.length ? `Unsupported saved choices adjusted: ${dropped.join(', ')}.` : '');
    initializedModel.current = model.key;
    appliedChoices.current = '';
  }, [model, savedChoices]);
  const currentChoices = useMemo<CreateChoices>(() => ({
    ...(spec.resolution ? { resolution } : {}),
    ...(spec.aspect_ratio ? { aspect_ratio: aspectRatio } : {}),
    ...(spec.image_size ? { image_size: imageSizePreset, ...(spec.image_size.custom_size ? { width, height } : {}) } : {}),
    ...(spec.quality ? { quality } : {}),
    ...(spec.safety_tolerance ? { safety_tolerance: safetyTolerance } : {}),
    ...(spec.steps_guidance ? { steps, guidance } : {}),
    ...(spec.enable_web_search ? { enable_web_search: enableWebSearch } : {}),
    ...(spec.negative_prompt ? { negative_prompt: negativePrompt } : {}),
    num_images: numImages, auto_expand: autoExpand,
  }), [spec, resolution, aspectRatio, imageSizePreset, width, height, quality, safetyTolerance, steps, guidance, enableWebSearch, negativePrompt, numImages, autoExpand]);
  useEffect(() => {
    if (!baseModel || !savedChoices || initializedModel.current !== baseModel) return;
    // The first render after changing models still contains the old form values.
    if (appliedChoices.current !== baseModel) { appliedChoices.current = baseModel; return; }
    choices.current[baseModel] = currentChoices;
    const timer = setTimeout(() => {
      settingsApi.putCreateChoices(baseModel, currentChoices).catch(() => setNotice('Could not save model settings.'));
      settingsApi.updateBaseModel(baseModel).catch(() => setNotice('Could not save the last model.'));
    }, 500);
    return () => clearTimeout(timer);
  }, [baseModel, currentChoices, savedChoices]);

  // Multi-LoRA helpers
  const addLora = () => {
    if (loraSelections.length >= 2) return;
    // Pick the first available LoRA not already selected
    const usedIds = new Set(loraSelections.map((s) => s.id));
    const firstAvailable = loraList?.items.find((l) => !usedIds.has(l.id));
    if (firstAvailable) {
      setLoraSelections([...loraSelections, { id: firstAvailable.id, scale: 1.0 }]);
    }
  };
  const removeLora = (index: number) => {
    setLoraSelections(loraSelections.filter((_, i) => i !== index));
  };
  const updateLoraId = (index: number, id: number) => {
    const updated = [...loraSelections];
    updated[index] = { ...updated[index], id };
    setLoraSelections(updated);
  };
  const updateLoraScale = (index: number, scale: number) => {
    const updated = [...loraSelections];
    updated[index] = { ...updated[index], scale };
    setLoraSelections(updated);
  };
  const getAvailableLorasForSlot = (slotIndex: number) => {
    const usedIds = new Set(loraSelections.filter((_, i) => i !== slotIndex).map((s) => s.id));
    return (loraList?.items || []).filter((l) => !usedIds.has(l.id));
  };

  // Full-size modal — store only the ID so the modal always uses fresh polled data
  const [selectedImageId, setSelectedImageId] = useState<number | null>(null);
  useEffect(() => {
    const id = Number(searchParams.get('image'));
    if (Number.isInteger(id) && id > 0) setSelectedImageId(id);
  }, [searchParams]);
  const { data: linkedImage } = useQuery({
    queryKey: ['generated-image', selectedImageId],
    queryFn: () => generationApi.getImage(selectedImageId!),
    enabled: selectedImageId != null,
    refetchInterval: 5000,
  });

  // Fetch base model from settings to initialize
  const hasInitialized = useRef(false);
  const hasAppliedUrlParams = useRef(false);
  const { data: baseModelData } = useQuery({
    queryKey: ['base-model'],
    queryFn: settingsApi.getBaseModel,
  });

  useEffect(() => {
    if (catalog && baseModelData && !hasInitialized.current) {
      hasInitialized.current = true;
      const modelEntry = BASE_MODELS.find((m) => m.value === baseModelData.base_model) ?? BASE_MODELS.find(m => m.value === catalog.defaults.generation_model);
      if (modelEntry) {
        setBaseModel(modelEntry.value);
        setGuidance(modelEntry.defaultGuidance);
      }
    }
  }, [baseModelData, catalog, BASE_MODELS]);

  // Read URL params (?lora=ID&prompt=TEXT)
  useEffect(() => {
    if (!catalog || hasAppliedUrlParams.current) return;
    const loraParam = searchParams.get('lora');
    const promptParam = searchParams.get('prompt');

    if (loraParam) {
      const parsed = parseInt(loraParam, 10);
      if (!isNaN(parsed)) {
        hasAppliedUrlParams.current = true;
        setLoraSelections([{ id: parsed, scale: 1.0 }]);
        // Fetch the LoRA to sync baseModel
        generationApi.getLora(parsed).then((lora) => {
          const modelEntry = BASE_MODELS.find((m) => m.value === lora.base_model);
          if (modelEntry) {
            hasInitialized.current = true;
            setBaseModel(modelEntry.value);
            setGuidance(modelEntry.defaultGuidance);
          }
        }).catch(() => {
          // LoRA not found or not accessible — ignore
        });
      }
    }
    if (promptParam) {
      hasAppliedUrlParams.current = true;
      setPrompt(promptParam);
    }
  }, [searchParams, catalog, BASE_MODELS]);

  // Fetch completed + uploaded LoRA models filtered by base model
  const { data: loraList } = useQuery({
    queryKey: ['lora-models', 'completed,uploaded', baseModel],
    queryFn: () => generationApi.listLora({ status: 'completed,uploaded', base_model: baseModel }),
  });

  // Fetch generated images with polling
  const { data: generatedImages, isLoading: imagesLoading } = useQuery({
    queryKey: ['generated-images'],
    queryFn: () => generationApi.listImages({ limit: 100, mode: 'generate' }),
    // Poll only while a result is on its way; starting a run invalidates this query.
    refetchInterval: query => query.state.data?.items.some(image => image.status === 'pending' || image.status === 'generating') ? 3000 : false,
  });

  // Fetch generation costs for cost estimate display
  const { data: generationCosts } = useQuery({
    queryKey: ['generation-costs'],
    queryFn: () => billingApi.getGenerationCosts(),
    staleTime: 5 * 60 * 1000, // costs don't change often
  });

  // Check if this model has variable pricing (resolution multipliers, megapixel, etc.)
  const hasVariablePricing = generationCosts?.variable_pricing_models?.includes(baseModel) ?? false;

  // Dynamic cost query — only fires for models with variable pricing
  const { data: dynamicEstimate } = useQuery({
    queryKey: ['generation-estimate', baseModel, resolution, enableWebSearch, width, height, imageSizePreset, quality, loraSelections.length > 0],
    queryFn: () => billingApi.estimateGenerationCost({
      base_model: baseModel,
      resolution: modelCaps.usesResolutionAspect ? resolution : undefined,
      enable_web_search: modelCaps.hasWebSearch ? enableWebSearch : undefined,
      width: (modelCaps.hasWidthHeight || (modelCaps.hasImageSizePreset && imageSizePreset === 'custom')) ? width : undefined,
      height: (modelCaps.hasWidthHeight || (modelCaps.hasImageSizePreset && imageSizePreset === 'custom')) ? height : undefined,
      image_size: (modelCaps.hasImageSizePreset && imageSizePreset !== 'custom') ? imageSizePreset : undefined,
      quality: spec.quality ? quality : undefined,
      with_lora: modelCaps.hasLora && loraSelections.length > 0,
    }),
    enabled: hasVariablePricing,
    staleTime: 60_000,
  });

  // Compute estimated cost in sparks
  const estimatedCostPerImage = (() => {
    // Use dynamic estimate for models with variable pricing
    if (hasVariablePricing && dynamicEstimate?.estimated_sparks != null) {
      return dynamicEstimate.estimated_sparks;
    }
    // Fall back to static costs
    if (!generationCosts?.costs) return null;
    const modelCosts = generationCosts.costs[baseModel];
    if (!modelCosts) return null;
    const hasLora = modelCaps.hasLora && loraSelections.length > 0;
    return hasLora ? (modelCosts.with_lora ?? null) : (modelCosts.without_lora ?? null);
  })();
  const totalEstimatedCost = estimatedCostPerImage != null ? estimatedCostPerImage * numImages : null;

  // Generate mutation
  const deleteMutation = useMutation({
    mutationFn: generationApi.deleteImage,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['generated-images'] });
    },
    onError: (err: Error) => {
      toast.error(`Delete failed: ${err.message}`);
    },
  });

  const expandMutation = useMutation({
    mutationFn: (promptText: string) => generationApi.expandPrompt(promptText),
    onSuccess: (data) => {
      setPrompt(data.expanded_prompt);
      toast.success('Prompt expanded');
    },
    onError: (err: Error) => {
      toast.error(`Expand failed: ${err.message}`);
    },
  });

  const generateMutation = useMutation({
    mutationFn: generationApi.generate,
    onSuccess: (data) => {
      if (loraSelections.length > 0) {
        trackFunnelStep('training', 'first_generation', {
          loraIds: loraSelections.map((s) => s.id),
          baseModel,
          numImages: data.generated_image_ids.length,
        });
      }
      toast.success(`Generation started (${data.generated_image_ids.length} images)`);
      queryClient.invalidateQueries({ queryKey: ['generated-images'] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (err: Error) => {
      toast.error(`Generation failed: ${err.message}`);
    },
  });

  const buildGenerateParams = (finalPrompt: string) => {
    const params: Parameters<typeof generationApi.generate>[0] = {
      prompt: finalPrompt,
      base_model: baseModel,
      num_images: numImages,
    };

    if (modelCaps.hasNegativePrompt && negativePrompt.trim()) params.negative_prompt = negativePrompt.trim();
    if (spec.seed && seed) params.seed = parseInt(seed);
    if (spec.quality && quality) params.quality = quality;

    if (modelCaps.hasLora && loraSelections.length > 0) {
      params.loras = loraSelections.map((s) => ({ lora_model_id: s.id, lora_scale: s.scale }));
    }

    if (modelCaps.hasWidthHeight) {
      params.width = width;
      params.height = height;
    }
    if (modelCaps.hasStepsGuidance) {
      params.num_inference_steps = steps;
      params.guidance_scale = guidance;
    }
    if (modelCaps.usesResolutionAspect) {
      if (spec.resolution && resolution) params.resolution = resolution;
      if (spec.aspect_ratio && aspectRatio) params.aspect_ratio = aspectRatio;
    }
    if (modelCaps.hasImageSizePreset) {
      if (imageSizePreset === 'custom') {
        params.width = width;
        params.height = height;
      } else if (imageSizePreset) {
        params.image_size = imageSizePreset;
      }
    }
    if (modelCaps.hasSafetyTolerance) {
      params.safety_tolerance = safetyTolerance;
    }
    if (modelCaps.hasWebSearch) {
      params.enable_web_search = enableWebSearch;
    }

    return params;
  };

  const handleGenerate = async (retry?: { prompt: string; count: number }) => {
    if (!model || !savedChoices || initializedModel.current !== model.key) { toast.error('Model settings are not ready'); return; }
    if (!(retry?.prompt ?? prompt).trim()) {
      toast.error('Please enter a prompt');
      return;
    }

    let finalPrompt = (retry?.prompt ?? prompt).trim();
    setIsGenerating(true);

    if (autoExpand) {
      try {
        const result = await generationApi.expandPrompt(finalPrompt);
        finalPrompt = result.expanded_prompt;
        setPrompt(finalPrompt);
      } catch (err) {
        toast.error(`Auto-expand failed: ${err instanceof Error ? err.message : String(err)}`);
        setIsGenerating(false);
        return;
      }
    }

    generateMutation.mutate({ ...buildGenerateParams(finalPrompt), ...(retry ? { num_images: Math.min(retry.count, modelCaps.maxImages) } : {}) }, {
      onSettled: () => setIsGenerating(false),
    });
  };

  function changeModel(key: string) {
    if (key === baseModel) return;
    const next = catalog?.generation.find(entry => entry.key === key);
    if (!next) return;
    choices.current[baseModel] = currentChoices;
    // Flush the outgoing model so switching within the debounce window cannot lose choices.
    settingsApi.putCreateChoices(baseModel, currentChoices).catch(() => setNotice('Could not save model settings.'));
    settingsApi.updateBaseModel(key).catch(() => setNotice('Could not save the last model.'));
    setLoraSelections([]);
    setBaseModel(key);
  }

  const [retryRun, setRetryRun] = useState<{ prompt: string; count: number } | null>(null);
  useEffect(() => {
    if (!retryRun || initializedModel.current !== baseModel) return;
    const timer = setTimeout(() => {
      setRetryRun(null);
      void handleGenerate(retryRun);
    }, 0);
    return () => clearTimeout(timer);
  });

  const images = useMemo(() => (generatedImages?.items || [])
    .filter(image => image.generation_params?.mode !== 'edit')
    .sort((a, b) => parseUTC(b.created_at).getTime() - parseUTC(a.created_at).getTime() || b.id - a.id), [generatedImages]);
  const completed = useMemo(() => images.filter(image => image.status === 'completed'), [images]);
  const selectedImage = selectedImageId != null
    ? images.find((img) => img.id === selectedImageId) ?? (linkedImage?.generation_params?.mode !== 'edit' ? linkedImage : null) ?? null
    : null;

  const runs = new Map<string, GeneratedImage[]>();
  for (const image of images) {
    const key = image.job_id != null ? `job-${image.job_id}` : `image-${image.id}`;
    runs.set(key, [...(runs.get(key) ?? []), image]);
  }
  const [density, setDensity] = useState<'S' | 'M' | 'L'>('M');
  const [dismissed, setDismissed] = useState<string[]>([]);
  useEffect(() => {
    try {
      const value = localStorage.getItem('library-density');
      if (value === 'S' || value === 'M' || value === 'L') setDensity(value);
      const stored: unknown = JSON.parse(localStorage.getItem(`create-dismissed:${user?.id}`) || '[]');
      setDismissed(Array.isArray(stored) ? stored.filter((key): key is string => typeof key === 'string') : []);
    } catch { /* Browser storage is optional. */ }
  }, [user?.id]);
  function dismiss(key: string) {
    const next = [...dismissed, key];
    setDismissed(next);
    try { localStorage.setItem(`create-dismissed:${user?.id}`, JSON.stringify(next)); } catch { /* Browser storage is optional. */ }
  }
  const labelFor = (key: string) => catalog?.generation.find(entry => entry.key === key)?.label || key;
  function failure(run: GeneratedImage[]) {
    const failed = run.filter(image => image.status === 'failed' && !/cancelled|canceled/i.test(image.error_message || ''));
    const first = failed[0] ?? run[0];
    const policy = failed.some(image => /content_policy_violation|content checker/i.test(image.error_message || ''));
    const timeout = failed.some(image => /timeout|timed out|lease expired/i.test(image.error_message || ''));
    const free = failed.every(image => !image.cost_sparks);
    const label = labelFor(first.base_model);
    const partial = failed.length < run.length;
    const title = partial ? `${failed.length} of ${run.length} results didn't finish.` : policy ? `${label} declined this prompt.` : timeout ? `${label} didn't finish in time.` : `${label} couldn't make this image.`;
    let body: string;
    if (policy) {
      body = `${label}'s content check flagged the prompt.`;
      if (!partial) body += ` Nothing was made${free ? ' and no sparks were charged' : ''}.`;
      body += ' Other models apply different rules, so the same prompt may work elsewhere.';
    } else if (timeout) {
      body = `${partial ? `${label} didn't finish in time. ` : ''}${free ? "It wasn't charged. " : ''}Trying again usually works.`;
    } else {
      body = partial ? `${label} couldn't finish the request.${free ? ' Nothing was charged.' : ''}` : free ? 'Nothing was charged.' : '';
    }
    return { failed, first, policy, partial, title, body };
  }
  const selectedFailure = selectedImage ? failure(
    selectedImage.job_id != null ? runs.get(`job-${selectedImage.job_id}`) ?? [selectedImage] : [selectedImage]
  ) : null;
  useEffect(() => {
    if (selectedImageId == null) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.getElementById('create-viewer-close')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedImageId(null);
      if (event.key === 'Tab') {
        const controls = Array.from(document.querySelectorAll<HTMLElement>('[data-create-viewer] button, [data-create-viewer] a, [data-create-viewer] summary'));
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
      const index = completed.findIndex(image => image.id === selectedImageId);
      const next = event.key === 'ArrowLeft' ? index - 1 : event.key === 'ArrowRight' ? index + 1 : -1;
      if (index >= 0 && completed[next]) { event.preventDefault(); setSelectedImageId(completed[next].id); }
    };
    window.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = overflow; window.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [selectedImageId, completed]);
  const chipClass = 'min-w-0 max-w-full rounded-md border border-input bg-background px-2 py-1 text-xs';
  const modelControl = (
    <select aria-label="Model" disabled={!savedChoices} value={baseModel} onChange={event => changeModel(event.target.value)} className={chipClass}>
      {BASE_MODELS.map(entry => (
        <option key={entry.value} value={entry.value}>{entry.label}</option>
      ))}
    </select>
  );
  const shapeSelect = (spec.aspect_ratio ? (
    <select aria-label="Shape" value={aspectRatio} onChange={event => { setAspectRatio(event.target.value); }} className={chipClass}>
      {ASPECT_RATIOS.map(option => (
        <option key={option.value}>{option.value}</option>
      ))}
    </select>
  ) : spec.image_size ? (
    <select aria-label="Shape" value={imageSizePreset} onChange={event => { setImageSizePreset(event.target.value); }} className={chipClass}>
      {IMAGE_SIZE_PRESETS.map(option => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  ) : <span className={chipClass}>{width} × {height}</span>);
  const shapeControl = (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
      {shapeSelect}
      {spec.image_size?.custom_size && imageSizePreset === 'custom' && (
        <>
          <input aria-label="Width" type="number" min={256} max={2048} step={8} value={width}
            onChange={event => setWidth(Math.max(256, Math.min(2048, Number(event.target.value))))}
            className={`${chipClass} w-20`} />
          <span>×</span>
          <input aria-label="Height" type="number" min={256} max={2048} step={8} value={height}
            onChange={event => setHeight(Math.max(256, Math.min(2048, Number(event.target.value))))}
            className={`${chipClass} w-20`} />
        </>
      )}
    </span>
  );
  const countControl = (
    <select aria-label="Results" value={numImages} onChange={event => setNumImages(Number(event.target.value))} className={chipClass}>
      {Array.from({ length: modelCaps.maxImages }, (_, index) => index + 1).map(count => (
        <option key={count} value={count}>{count} {count === 1 ? 'result' : 'results'}</option>
      ))}
    </select>
  );
  const qualityControl = spec.quality ? (
    <select aria-label="Quality" value={quality} onChange={event => { setQuality(event.target.value); }} className={chipClass}>
      {spec.quality.options?.map(value => <option key={value}>{value}</option>)}
    </select>
  ) : spec.resolution ? (
    <select aria-label="Resolution" value={resolution} onChange={event => { setResolution(event.target.value); }} className={chipClass}>
      {RESOLUTIONS.map(option => (
        <option key={option.value}>{option.value}</option>
      ))}
    </select>
  ) : <span className={chipClass}>Standard resolution</span>;

  const gridItems = [...images.filter(image => image.status === 'pending' || image.status === 'generating'), ...completed]
    .map(image => image.width && image.height ? image : { ...image, ...shapeSize(image) });
  return (
    <div className="-mx-5 -my-5 h-[calc(100%+40px)] min-h-0">
      <style jsx global>{`
        @keyframes create-shimmer {
          to { background-position: -220% 0; }
        }
      `}</style>
      <Stage
        mobileFeedKey={images.length}
        mobileSheets={{ Model: <label className="grid gap-2">Model{modelControl}</label> }}
        canvas={
          <>
            {references.length > 0 && (
              <div className="shrink-0 space-y-2">
                <p className="text-xs text-muted-foreground">Selected images for visual reference while writing. Create uses your prompt and optional LoRAs.</p>
                <div className="flex gap-2 overflow-x-auto">
                  {references.map(image => (
                    <LibraryImage key={image.id} src={image.url} alt={`Selected image ${image.id}`} className="h-[52px] w-[52px] shrink-0 rounded object-cover" />
                  ))}
                </div>
              </div>
            )}
            {imagesLoading && <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />}
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">{completed.length} images you made · Newest first</span>
              <Segmented label="Image size" options={(['S', 'M', 'L'] as const).map(key => ({ key, label: key }))} value={density} onChange={value => {
                setDensity(value);
                try { localStorage.setItem('library-density', value); } catch { /* Browser storage is optional. */ }
              }} />
            </div>
            {Array.from(runs, ([key, run]) => {
              const info = failure(run);
              if (!info.failed.length || dismissed.includes(key)) return null;
              const { first, partial, policy, title, body, failed } = info;
              const retry = (modelKey: string) => {
                changeModel(modelKey);
                setRetryRun({ prompt: first.prompt, count: failed.length });
              };
              return (
                <section key={key} role="status" className="relative shrink-0 rounded-md border border-danger/20 border-l-[3px] border-l-danger bg-danger/5 p-4 pr-10 text-sm">
                  <button
                    aria-label="Dismiss notice"
                    onClick={() => dismiss(key)}
                    className="absolute right-3 top-3"
                  >
                    <X className="h-4 w-4" />
                  </button>
                  <h3 className="font-semibold">{title}</h3>
                  <p className="mt-1 text-muted-foreground">{body}</p>
                  <p className="my-2 text-xs text-muted-foreground">“{first.prompt.slice(0, 90)}{first.prompt.length > 90 ? '…' : ''}” · {relativeTime(first.created_at)}</p>
                  <div className="flex flex-wrap gap-2">
                    {partial ? (
                      <button className="rounded-md border border-foreground bg-foreground px-2.5 py-1 text-xs font-medium text-background hover:opacity-90" onClick={() => retry(first.base_model)}>Make {failed.length} more</button>
                    ) : policy ? (
                      <>
                        {catalog && first.base_model !== catalog.defaults.generation_model && (
                          <button className="rounded-md border border-foreground bg-foreground px-2.5 py-1 text-xs font-medium text-background hover:opacity-90" onClick={() => retry(catalog.defaults.generation_model)}>
                            Try with {labelFor(catalog.defaults.generation_model)}
                          </button>
                        )}
                        <button className="rounded-md border border-input bg-background px-2.5 py-1 text-xs font-medium hover:bg-accent" onClick={() => {
                          changeModel(first.base_model);
                          setPrompt(first.prompt);
                          document.querySelector<HTMLTextAreaElement>('.tool-composer textarea')?.focus();
                        }}>
                          Edit prompt
                        </button>
                      </>
                    ) : (
                      <button className="rounded-md border border-foreground bg-foreground px-2.5 py-1 text-xs font-medium text-background hover:opacity-90" onClick={() => retry(first.base_model)}>Try again</button>
                    )}
                    <button className="rounded-md border border-input bg-background px-2.5 py-1 text-xs font-medium hover:bg-accent" onClick={() => setSelectedImageId(first.id)}>Details</button>
                  </div>
                </section>
              );
            })}
            <div className="shrink-0">
              <AppendOnlyGrid images={gridItems} density={density}>
                {(image) => (
                  <button
                    aria-label={`Open image ${image.id}`}
                    disabled={image.status !== 'completed'}
                    onClick={() => setSelectedImageId(image.id)}
                    className="create-run group relative block h-full w-full overflow-hidden rounded-md bg-muted"
                  >
                    {image.status === 'completed' ? (
                      <>
                        <CreateThumbnail
                          image={image}
                          density={density}
                          onPreviewLoaded={(source, url) => previews.current.set(image.id, { source, url })}
                        />
                        <span className="absolute bottom-2 left-2 rounded bg-black/45 px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider text-white backdrop-blur">
                          Generated
                        </span>
                      </>
                    ) : (
                      <span className="block h-full w-full bg-[linear-gradient(100deg,transparent_20%,hsl(var(--muted-foreground)/0.12)_45%,transparent_70%)] bg-[length:220%_100%] motion-safe:animate-[create-shimmer_1.4s_linear_infinite]" />
                    )}
                  </button>
                )}
              </AppendOnlyGrid>
            </div>
          </>
        }
        composer={
          <Composer
            value={prompt}
            onChange={setPrompt}
            onApply={handleGenerate}
            disabled={!model || !savedChoices || isGenerating || !prompt.trim()}
            count={numImages}
            cost={totalEstimatedCost ?? undefined}
            placeholder="Describe the image you want to create…"
            action="Create"
            mobileChips={<><SheetButton title="Model" label={model?.label || 'Model'} /><SheetButton title="Create settings" label={`${aspectRatio || imageSizePreset || 'Shape'} · ${numImages} ${numImages === 1 ? 'result' : 'results'}`} /></>}
            chips={<>{modelControl}{shapeControl}{countControl}{qualityControl}</>}
          />
        }
        settings={
          <>
            <h2 className="font-semibold">Advanced for {model?.label}</h2>
            <p className="text-xs text-muted-foreground">SightLab remembers what you pick for each model.</p>
            <Notice>{notice}</Notice>
            <div className="grid gap-3 md:hidden">
              <label className="grid gap-1">Model{modelControl}</label>
              <label className="grid gap-1">Shape{shapeControl}</label>
              <label className="grid gap-1">Results{countControl}</label>
              <label className="grid gap-1">{spec.quality ? 'Quality' : 'Resolution'}{qualityControl}</label>
            </div>
            <p className="font-mono text-xs text-muted-foreground">{totalEstimatedCost != null ? `about ${totalEstimatedCost} sparks` : 'Price unavailable'}</p>
            {/* LoRA selections (max 2) — only for models that support LoRA */}
            {modelCaps.hasLora && (
              <div className="flex flex-col gap-3">
                {loraSelections.map((sel, idx) => {
                  const available = getAvailableLorasForSlot(idx);
                  return (
                    <div key={idx} className="flex flex-wrap items-end gap-2">
                      <div className="min-w-0 w-full">
                        <label className="block text-xs text-muted-foreground mb-1">
                          LoRA {loraSelections.length > 1 ? idx + 1 : ''}
                        </label>
                        <select
                          value={sel.id}
                          onChange={(e) => updateLoraId(idx, parseInt(e.target.value))}
                          className="w-full px-3 py-2 border border-border rounded-lg text-sm"
                        >
                          {available.map((lora) => (
                            <option key={lora.id} value={lora.id}>
                              {lora.trigger_word ? `${lora.name} (${lora.trigger_word})` : lora.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="w-full">
                        <label className="block text-xs text-muted-foreground mb-1">
                          Scale: {sel.scale.toFixed(1)}
                        </label>
                        <Slider
                          min={0}
                          max={20}
                          value={Math.round(sel.scale * 10)}
                          onChange={(v) => updateLoraScale(idx, v / 10)}
                          className="w-full"
                        />
                      </div>
                      <button
                        onClick={() => removeLora(idx)}
                        className="p-2 text-muted-foreground hover:text-red-500 transition-colors"
                        title="Remove LoRA"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  );
                })}
                {loraSelections.length < 2 && (loraList?.items.length ?? 0) > loraSelections.length && (
                  <button
                    onClick={addLora}
                    className="flex items-center gap-1 px-3 py-2 text-sm border border-dashed border-border rounded-lg text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {loraSelections.length === 0 ? 'Add LoRA' : 'Add 2nd LoRA'}
                  </button>
                )}
              </div>
            )}



            <label className="flex items-center gap-2">
              <input type="checkbox" checked={autoExpand} onChange={event => setAutoExpand(event.target.checked)} />
              Auto-expand on create
            </label>
            <button onClick={() => expandMutation.mutate(prompt.trim())} disabled={expandMutation.isPending || !prompt.trim()} className="rounded-md border border-input p-2 disabled:opacity-50">
              {expandMutation.isPending ? 'Expanding…' : 'Expand prompt'}
              {generationCosts?.expand_prompt_cost != null && ` (about ${generationCosts.expand_prompt_cost} sparks)`}
            </button>
            {/* Negative prompt (only for models that support it) */}
            {modelCaps.hasNegativePrompt && (
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Negative Prompt</label>
                <input
                  type="text"
                  value={negativePrompt}
                  onChange={(e) => setNegativePrompt(e.target.value)}
                  placeholder="Things to avoid..."
                  className="w-full px-3 py-2 border border-border rounded-lg text-sm"
                />
              </div>
            )}

            {/* Safety Tolerance + Web Search */}
            {(modelCaps.hasSafetyTolerance || modelCaps.hasWebSearch) && (
              <div className="grid grid-cols-1 gap-4">
                {modelCaps.hasSafetyTolerance && (
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">Safety Tolerance</label>
                    <select
                      value={safetyTolerance}
                      onChange={(e) => { setSafetyTolerance(e.target.value); }}
                      className="w-full px-3 py-1.5 border border-border rounded-lg text-sm"
                    >
                      {SAFETY_LEVELS.filter((s) => s.level <= (modelCaps.maxSafetyLevel ?? 6)).map((s) => (
                        <option key={s.value} value={s.value}>{s.label}</option>
                      ))}
                    </select>
                  </div>
                )}
                {modelCaps.hasWebSearch && (
                  <div className="flex items-end pb-1">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={enableWebSearch}
                        onChange={(e) => setEnableWebSearch(e.target.checked)}
                        className="rounded"
                      />
                      Enable web search
                    </label>
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 gap-4">
              {/* Steps */}
              {modelCaps.hasStepsGuidance && (
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">
                    Steps: {steps}
                  </label>
                  <Slider
                    min={spec.steps_guidance?.steps?.minimum ?? 1}
                    max={spec.steps_guidance?.steps?.maximum ?? 50}
                    value={steps}
                    onChange={(v) => { setSteps(v); }}
                    className="w-full"
                  />
                </div>
              )}

              {/* Guidance */}
              {modelCaps.hasStepsGuidance && (
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">
                    Guidance: {guidance.toFixed(1)}
                  </label>
                  <Slider
                    min={(spec.steps_guidance?.guidance?.minimum ?? 0) * 10}
                    max={(spec.steps_guidance?.guidance?.maximum ?? 20) * 10}
                    value={Math.round(guidance * 10)}
                    onChange={(v) => { setGuidance(v / 10); }}
                    className="w-full"
                  />
                </div>
              )}

              {/* Seed */}
              {spec.seed && <div>
                <label className="block text-xs text-muted-foreground mb-1">Seed</label>
                <input
                  type="text"
                  value={seed}
                  onChange={(e) => setSeed(e.target.value.replace(/\D/g, ''))}
                  placeholder="Random"
                  className="w-full px-3 py-1.5 border border-border rounded-lg text-sm"
                />
              </div>}
            </div>

          </>
        }
      />
      {selectedImage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 md:p-6" onClick={() => setSelectedImageId(null)}>
          <div data-create-viewer role="dialog" aria-modal="true" aria-label={`Image ${selectedImage.id}`} className="grid h-full max-h-[900px] w-full max-w-[1440px] grid-rows-[minmax(0,1fr)_minmax(0,1fr)] overflow-hidden rounded-xl bg-card shadow-xl md:grid-cols-[minmax(0,1fr)_320px] md:grid-rows-1" onClick={event => event.stopPropagation()}>
            <div className="relative min-h-0 min-w-0 bg-black/40 p-10">
              <button id="create-viewer-close" aria-label="Close viewer" onClick={() => setSelectedImageId(null)} className="absolute left-3 top-3 z-10 rounded bg-black/60 px-2 py-1 text-sm text-white">Close · Esc</button>
              {selectedImage.status === 'completed' && selectedImage.object_key ? (
                <ProgressiveImage
                  src={previews.current.get(selectedImage.id)?.source || generationPreview(selectedImage)}
                  resolvedSource={previews.current.get(selectedImage.id)?.url}
                  highSrc={generationApi.getImageUrl(selectedImage.id)}
                  alt={selectedImage.prompt}
                  className="h-full w-full object-contain"
                />
              ) : selectedImage.status === 'failed' ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-white">
                  <strong>{selectedFailure?.title}</strong>
                  <p>{selectedFailure?.body}</p>
                </div>
              ) : (
                <Loader2 className="animate-spin text-white" />
              )}
              {([-1, 1] as const).map(direction => {
                const index = completed.findIndex(image => image.id === selectedImage.id);
                const next = index >= 0 ? completed[index + direction] : undefined;
                return next && (
                  <button
                    key={direction}
                    aria-label={direction < 0 ? 'Previous image' : 'Next image'}
                    onClick={() => setSelectedImageId(next.id)}
                    className={`absolute top-1/2 rounded bg-black/60 p-2 text-white ${direction < 0 ? 'left-1' : 'right-1'}`}
                  >
                    {direction < 0 ? '‹' : '›'}
                  </button>
                );
              })}
            </div>
            <aside className="min-h-0 overflow-y-auto p-5 text-sm">
              <h3 className="mb-5 text-lg font-semibold">{selectedImage.status === 'failed' ? "Didn’t finish" : `Image #${selectedImage.id}`}</h3>
              <h4 className="mb-2 font-medium">Prompt</h4>
              <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-muted-foreground">{selectedImage.prompt}</p>
              <h4 className="mb-2 mt-5 font-medium">How it was made</h4>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                {[
                  ['Model', labelFor(selectedImage.base_model)],
                  ['Shape', String(selectedImage.generation_params?.aspect_ratio || selectedImage.generation_params?.image_size || '—')],
                  ['Size', selectedImage.width && selectedImage.height ? `${selectedImage.width} × ${selectedImage.height}` : '—'],
                  ['Results in run', String(selectedImage.generation_params?.num_images ?? (selectedImage.job_id ? runs.get(`job-${selectedImage.job_id}`)?.length : 1) ?? 1)],
                  ['Seed', String(selectedImage.generation_params?.actual_seed ?? selectedImage.generation_params?.seed ?? '—')],
                  ['Cost', selectedImage.cost_sparks != null ? `${selectedImage.cost_sparks} sparks` : '—'],
                  ['Made', formatDate(selectedImage.created_at)],
                ].map(([key, value]) => (
                  <div key={key} className="contents">
                    <dt className="text-muted-foreground">{key}</dt>
                    <dd className="break-words text-right">{value}</dd>
                  </div>
                ))}
              </dl>
              {selectedImage.status === 'failed' && (
                <details className="mt-5">
                  <summary className="cursor-pointer">Provider message</summary>
                  <pre className="mt-2 whitespace-pre-wrap break-words text-xs">
                    {selectedImage.error_message || 'No provider message available.'}
                  </pre>
                </details>
              )}
              <div className="mt-5 flex flex-wrap gap-3 border-t pt-4">
                {selectedImage.library_image_id && (
                  <Link href={`/images?image_id=${selectedImage.library_image_id}`} className="rounded-md border px-3 py-2">
                    Open in library
                  </Link>
                )}
                <button onClick={() => {
                  if (window.confirm('Delete this generated image?')) {
                    deleteMutation.mutate(selectedImage.id);
                    setSelectedImageId(null);
                  }
                }} className="rounded-md border px-3 py-2 text-danger">Delete</button>
              </div>
            </aside>
          </div>
        </div>
      )}
    </div>
  );
}

function relativeTime(date: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - parseUTC(date).getTime()) / 60000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

// Pending results have no size yet; reserve their requested shape so the grid doesn't jump.
function shapeSize(image: GeneratedImage) {
  const match = /^(\d+):(\d+)$/.exec(String(image.generation_params?.aspect_ratio ?? ''));
  return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: 1, height: 1 };
}
