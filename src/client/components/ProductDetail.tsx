import React, { useState, useEffect } from 'react';
import { getProduct, saveDraft, getConnection, listFieldRegistry, type ProductDetail as ProductDetailType } from '../api';
import { CatalogClassificationPanel } from './CatalogClassificationPanel';
import { ViewHeader } from './common/ViewHeader';
import { colors } from '../theme';
import type { FieldRegistryEntry } from '../../shared/schemas/field-registry';

function ProductImage({ src, alt, title }: { src: string; alt: string; title: string }) {
  const [error, setError] = useState(false);

  useEffect(() => {
    setError(false);
  }, [src]);

  if (error || !src) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', textAlign: 'center', padding: 16 }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 12, color: '#94a3b8' }}>
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
          <line x1="12" y1="22.08" x2="12" y2="12" />
        </svg>
        <span style={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>No Image</span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      title={title}
      style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
      onError={() => setError(true)}
    />
  );
}

function decodeHtmlEntities(text: string | null | undefined): string {
  if (!text) return '';
  const txt = document.createElement('textarea');
  txt.innerHTML = text;
  return txt.value;
}

interface Props {
  sku: string;
  onBack: () => void;
}

export function ProductDetail({ sku, onBack }: Props) {
  const [data, setData] = useState<ProductDetailType | null>(null);
  const [registry, setRegistry] = useState<FieldRegistryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingRegistry, setLoadingRegistry] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [fieldValues, setFieldValues] = useState<Record<string, any>>({});
  
  // Custom workspace and media states
  const [images, setImages] = useState<string[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>('');
  const [pinnedFields, setPinnedFields] = useState<string[]>([]);
  const [customizingFields, setCustomizingFields] = useState(false);
  const [showAllFields, setShowAllFields] = useState(false);
  const [newImageName, setNewImageName] = useState('');
  const [showAddImageInput, setShowAddImageInput] = useState(false);

  const [mediaUrl, setMediaUrl] = useState(() => {
    return localStorage.getItem('shopsite_media_url') || '';
  });

  useEffect(() => {
    if (!localStorage.getItem('shopsite_media_url')) {
      getConnection().then(res => {
        if (res.connection && res.connection.cgiBaseUrl) {
          try {
            const url = new URL(res.connection.cgiBaseUrl);
            const derivedMediaUrl = `${url.protocol}//${url.host}/media/`;
            setMediaUrl(derivedMediaUrl);
            localStorage.setItem('shopsite_media_url', derivedMediaUrl);
          } catch (e) {
            console.error('Failed to parse cgiBaseUrl:', e);
          }
        }
      }).catch(err => {
        console.error('Failed to load connection settings:', err);
      });
    }
  }, []);

  useEffect(() => {
    setLoadingRegistry(true);
    listFieldRegistry().then(res => {
      // Filter out non-editable fields and 'SKU' from editable fields list
      const editableFields = res.entries.filter(e => e.editable && e.xmlField !== 'SKU');
      setRegistry(editableFields);
      if (res.entries.length > 0) {
        setWorkspaceId((res.entries[0] as any).workspaceId);
      }
      setLoadingRegistry(false);
    }).catch(err => {
      console.error('Failed to load field registry:', err);
      setLoadingRegistry(false);
    });
  }, []);

  useEffect(() => {
    setLoading(true);
    getProduct(sku).then(d => {
      setData(d);
      const product = d.product as any;
      
      // Initialize field values based on product data
      const values: Record<string, any> = {};
      
      values['Name'] = decodeHtmlEntities(product?.core?.name ?? '');
      values['Price'] = product?.core?.price ?? '';
      values['SaleAmount'] = product?.core?.salePrice ?? '';
      values['ProductDescription'] = decodeHtmlEntities(product?.core?.description ?? '');
      values['Weight'] = product?.core?.weight ?? '';
      values['Taxable'] = product?.core?.taxable ?? false;
      values['Graphic'] = product?.core?.media?.primary ?? '';
      values['MoreInformationGraphic'] = product?.core?.media?.primary ?? '';
      values['QuantityOnHand'] = product?.core?.inventory?.quantityOnHand ?? '';
      values['Availability'] = product?.core?.availability ?? '';
      
      if (product?.customFields) {
        Object.entries(product.customFields).forEach(([k, v]) => {
          values[k] = v;
        });
      }
      
      setFieldValues(values);

      // Initialize images state from product media
      const primary = product?.core?.media?.primary ?? '';
      const additional = product?.core?.media?.additional ?? [];
      const moreInfoGraphic = product?.shopsite?.preserved?.unknownElements?.['MoreInformationGraphic'] as string ?? '';
      
      const allImages = [primary];
      if (moreInfoGraphic && moreInfoGraphic !== 'none' && moreInfoGraphic !== primary) {
        allImages.push(moreInfoGraphic);
      }
      allImages.push(...additional);
      
      const filteredImages = allImages.filter(img => img && img !== 'none' && img !== '');
      setImages(filteredImages);

      setLoading(false);
    }).catch(err => {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    });
  }, [sku]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const core: any = {};
      const customFields: Record<string, string> = {};
      
      Object.entries(fieldValues).forEach(([field, val]) => {
        if (field === 'Name') core.name = val;
        else if (field === 'ProductDescription') core.description = val || null;
        else if (field === 'Weight') core.weight = val || null;
        else if (field === 'Taxable') core.taxable = !!val;
        else if (field === 'Graphic') {
          if (!core.media) core.media = { primary: null, additional: [] };
          core.media.primary = val || null;
        }
        else if (field === 'MoreInformationGraphic') {
          if (!core.media) core.media = { primary: null, additional: [] };
          if (!core.media.primary) core.media.primary = val || null;
        }
        else if (field === 'QuantityOnHand') {
          if (!core.inventory) core.inventory = { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null };
          core.inventory.quantityOnHand = val !== '' && val !== null && val !== undefined && val !== '' ? parseInt(val, 10) : null;
        }
        else if (field === 'Availability') core.availability = val || null;
        else if (field.startsWith('ProductField')) {
          customFields[field] = val || '';
        }
      });

      // Override media using our managed images list state
      core.media = {
        primary: images[0] || null,
        additional: images.slice(1),
      };

      const preserved = {
        unknownElements: {
          ...(data?.product as any)?.shopsite?.preserved?.unknownElements,
        },
        advancedBlocks: (data?.product as any)?.shopsite?.preserved?.advancedBlocks ?? {},
        rawAttributes: (data?.product as any)?.shopsite?.preserved?.rawAttributes ?? {},
      };
      delete (preserved.unknownElements as any)['MoreInformationGraphic'];

      const shopsite = {
        ...(data?.product as any)?.shopsite,
        preserved
      };
      
      await saveDraft(sku, {
        core,
        customFields,
        shopsite,
      });
      setMessage('Your changes are saved as a draft. They have not been sent to your store.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const styles: Record<string, React.CSSProperties> = {
    container: { padding: 24, maxWidth: 800 },
    title: { fontSize: 24, fontWeight: 600, marginBottom: 8 },
    subtitle: { fontSize: 14, color: '#6b7280', marginBottom: 24 },
    field: { marginBottom: 16 },
    label: { display: 'block', fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 4 },
    input: { width: '100%', padding: '8px 12px', fontSize: 14, border: '1px solid #d1d5db', borderRadius: 4, boxSizing: 'border-box' as any },
    buttonRow: { display: 'flex', gap: 8, marginTop: 24 },
    button: { padding: '8px 20px', fontSize: 14, cursor: 'pointer', background: colors.uniformGreen, color: colors.feedBagCream, border: 'none', borderRadius: 4 },
    back: { padding: '8px 20px', fontSize: 14, cursor: 'pointer', background: '#6b7280', color: '#fff', border: 'none', borderRadius: 4, marginBottom: 20 },
    error: { color: '#dc2626', padding: '8px 12px', background: '#fef2f2', borderRadius: 4, margin: '8px 0' },
    message: { color: '#16a34a', padding: '8px 12px', background: '#f0fdf4', borderRadius: 4, margin: '8px 0' },
    info: { fontSize: 12, color: '#9ca3af', marginTop: 16 },
    sectionTitle: { fontSize: 16, fontWeight: 600, borderBottom: '1px solid #e5e7eb', paddingBottom: 6, marginTop: 24, marginBottom: 16, color: '#111827' },
    grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 },
  };

  // Helper for pinned fields retrieval
  const DEFAULT_PINNED_FIELDS = ['Name', 'Price', 'SaleAmount', 'ProductDescription', 'QuantityOnHand', 'Availability'];

  const getPinnedFields = (wsId: string): string[] => {
    if (!wsId) return DEFAULT_PINNED_FIELDS;
    try {
      const stored = localStorage.getItem(`baystate_cms_pinned_fields_${wsId}`);
      if (stored) return JSON.parse(stored);
    } catch (e) {
      console.error(e);
    }
    return DEFAULT_PINNED_FIELDS;
  };

  const toggleFieldPinned = (xmlField: string) => {
    if (xmlField === 'Name' || xmlField === 'ProductDescription') return;
    const currentPinned = getPinnedFields(workspaceId);
    let newPinned: string[];
    if (currentPinned.includes(xmlField)) {
      newPinned = currentPinned.filter(f => f !== xmlField);
    } else {
      newPinned = [...currentPinned, xmlField];
    }
    if (workspaceId) {
      localStorage.setItem(`baystate_cms_pinned_fields_${workspaceId}`, JSON.stringify(newPinned));
    }
    setPinnedFields(newPinned);
  };

  // Image manipulation helper functions
  const moveImage = (index: number, direction: 'left' | 'right') => {
    const targetIndex = direction === 'left' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= images.length) return;
    const newImages = [...images];
    const temp = newImages[index];
    newImages[index] = newImages[targetIndex];
    newImages[targetIndex] = temp;
    setImages(newImages);
  };

  const removeImage = (index: number) => {
    const newImages = images.filter((_, i) => i !== index);
    setImages(newImages);
  };

  const setAsPrimary = (index: number) => {
    if (index <= 0 || index >= images.length) return;
    const newImages = [...images];
    const target = newImages[index];
    newImages.splice(index, 1);
    newImages.unshift(target);
    setImages(newImages);
  };

  const addImage = () => {
    const name = newImageName.trim();
    if (!name) return;
    if (images.includes(name)) {
      alert('This image filename is already in the list.');
      return;
    }
    if (images.length >= 21) {
      alert('Maximum of 21 images (1 primary and 20 additional) allowed.');
      return;
    }
    setImages([...images, name]);
    setNewImageName('');
    setShowAddImageInput(false);
  };

  // Load pinned fields when workspaceId becomes available
  useEffect(() => {
    if (workspaceId) {
      setPinnedFields(getPinnedFields(workspaceId));
    }
  }, [workspaceId]);

  const { pinnedFieldsList, additionalFieldsList } = React.useMemo(() => {
    const currentPinned = workspaceId ? getPinnedFields(workspaceId) : DEFAULT_PINNED_FIELDS;
    
    // Filter out Graphic and MoreInformationGraphic
    const editableFields = registry.filter(
      (e: any) => e.xmlField !== 'Graphic' && e.xmlField !== 'MoreInformationGraphic'
    );

    const pinned: any[] = [];
    const additional: any[] = [];

    editableFields.forEach((field) => {
      const isForced = field.xmlField === 'Name' || field.xmlField === 'ProductDescription' ||
        field.xmlField === 'Price' || field.xmlField === 'SaleAmount';
      if (isForced || currentPinned.includes(field.xmlField)) {
        pinned.push(field);
      } else {
        additional.push(field);
      }
    });

    return { pinnedFieldsList: pinned, additionalFieldsList: additional };
  }, [registry, workspaceId, pinnedFields]);

  if (loading || loadingRegistry) return <div style={{ padding: 24, color: '#6b7280' }}>Loading product details...</div>;
  if (error) return <div style={{ padding: 24 }}><div style={styles.error}>{error}</div><button style={styles.back} onClick={onBack}>Back</button></div>;

  const primaryImage = images[0] || '';
  const imageUrl = primaryImage ? (mediaUrl ? (mediaUrl.endsWith('/') ? mediaUrl : mediaUrl + '/') + primaryImage : '') : '';

  // Find Name and Description
  const nameField = pinnedFieldsList.find(e => e.xmlField === 'Name');
  const descField = pinnedFieldsList.find(e => e.xmlField === 'ProductDescription');
  const otherPinnedFields = pinnedFieldsList.filter(e => e.xmlField !== 'Name' && e.xmlField !== 'ProductDescription');

  const renderFieldInput = (entry: FieldRegistryEntry) => {
    const value = fieldValues[entry.xmlField] ?? '';
    const onChange = (val: any) => {
      setFieldValues(prev => ({ ...prev, [entry.xmlField]: val }));
    };
    if (entry.xmlField === 'Price' || entry.xmlField === 'SaleAmount') {
      const note = entry.xmlField === 'Price'
        ? 'Set when this product was added. It cannot be changed here.'
        : 'This amount is read-only here.';
      return (
        <div key={entry.xmlField} style={styles.field}>
          <label style={styles.label}>{entry.label}</label>
          <output
            aria-label={`${entry.label}, read only`}
            style={{ ...styles.input, display: 'block', background: '#f8faf7', whiteSpace: 'pre-wrap' }}
          >
            {value || 'Not set'}
          </output>
          <small style={{ color: '#6b7280', fontSize: 12 }}>{note}</small>
        </div>
      );
    }

    if (entry.xmlField === 'ProductDescription') {
      return (
        <div key={entry.xmlField} style={styles.field}>
          <label style={styles.label}>{entry.label}</label>
          <textarea
            style={{ ...styles.input, minHeight: 100, fontFamily: 'inherit' }}
            value={value}
            onChange={e => onChange(e.target.value)}
          />
        </div>
      );
    }

    if (entry.dataType === 'boolean') {
      return (
        <div key={entry.xmlField} style={{ ...styles.field, display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, marginBottom: 16 }}>
          <input
            type="checkbox"
            id={entry.xmlField}
            checked={!!value}
            onChange={e => onChange(e.target.checked)}
            style={{ cursor: 'pointer', width: 16, height: 16 }}
          />
          <label htmlFor={entry.xmlField} style={{ ...styles.label, marginBottom: 0, cursor: 'pointer' }}>
            {entry.label}
          </label>
        </div>
      );
    }

    return (
      <div key={entry.xmlField} style={styles.field}>
        <label style={styles.label}>{entry.label}</label>
        <input
          type={entry.dataType === 'number' ? 'number' : 'text'}
          style={styles.input}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={entry.dataType === 'number' ? '0.00' : ''}
          step={entry.dataType === 'number' ? 'any' : undefined}
        />
      </div>
    );
  };

  const nameVal = fieldValues['Name'] ?? '';

  const styleTagContent = `
    @keyframes slideDown {
      from { opacity: 0; transform: translateY(-8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .image-card {
      position: relative;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 8px;
      background: #ffffff;
      width: 130px;
      height: 160px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: space-between;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    .image-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.08);
      border-color: #cbd5e1;
    }
    .image-card-primary {
      border-color: #2563eb;
      box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
    }
    .image-action-overlay {
      position: absolute;
      top: 4px;
      right: 4px;
      left: 4px;
      display: flex;
      justify-content: space-between;
      gap: 2px;
      opacity: 0;
      transition: opacity 0.2s ease;
    }
    .image-card:hover .image-action-overlay {
      opacity: 1;
    }
    .image-action-btn {
      background: rgba(15, 23, 42, 0.85);
      color: #ffffff;
      border: none;
      border-radius: 4px;
      width: 24px;
      height: 24px;
      font-size: 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s ease;
    }
    .image-action-btn:hover {
      background: rgba(15, 23, 42, 1);
    }
    .image-action-btn-danger:hover {
      background: #ef4444;
    }
    .custom-checklist-container {
      position: relative;
    }
    .custom-checklist-dropdown {
      position: absolute;
      top: 100%;
      right: 0;
      z-index: 50;
      width: 280px;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
      padding: 16px;
      margin-top: 8px;
      animation: slideDown 0.15s ease-out;
    }
    .add-image-card {
      border: 2px dashed #cbd5e1;
      background: #f8fafc;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
    }
    .add-image-card:hover {
      background: #f1f5f9;
      border-color: #94a3b8;
    }
  `;

  return (
    <div style={styles.container}>
      <style dangerouslySetInnerHTML={{ __html: styleTagContent }} />
      <button style={styles.back} onClick={onBack}>← Back to Catalog</button>
      
      <ViewHeader
        title={nameVal || 'Product details'}
        description="Review product details. The price entered when this product was added stays the same."
        actions={
          <div className="custom-checklist-container">
            <button
              onClick={() => setCustomizingFields(prev => !prev)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 12px',
                fontSize: 13,
                fontWeight: 500,
                color: '#475569',
                background: '#f1f5f9',
                border: '1px solid #cbd5e1',
                borderRadius: 6,
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
            >
              Choose visible details
            </button>
          </div>
        }
      />
      {customizingFields && (
        <div className="custom-checklist-dropdown" style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: '#1e293b', marginBottom: 12, borderBottom: '1px solid #f1f5f9', paddingBottom: 6 }}>
            Choose which product details to show
          </div>
          <div style={{ maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {registry
              .filter(e => e.xmlField !== 'Graphic' && e.xmlField !== 'MoreInformationGraphic')
              .map(field => {
                const isForced = field.xmlField === 'Name' || field.xmlField === 'ProductDescription';
                const isPinned = isForced || pinnedFields.includes(field.xmlField);
                return (
                  <label
                    key={field.xmlField}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 13,
                      color: isForced ? '#94a3b8' : '#334155',
                      cursor: isForced ? 'not-allowed' : 'pointer',
                      userSelect: 'none',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isPinned}
                      disabled={isForced}
                      onChange={() => toggleFieldPinned(field.xmlField)}
                      style={{ cursor: isForced ? 'not-allowed' : 'pointer' }}
                    />
                    {field.label || field.xmlField} {isForced && <span style={{ fontSize: 10, color: '#94a3b8' }}>(Always shown)</span>}
                  </label>
                );
              })}
          </div>
          <button
            onClick={() => setCustomizingFields(false)}
            style={{
              width: '100%',
              marginTop: 12,
              padding: '6px 0',
              fontSize: 12,
              fontWeight: 500,
              color: colors.feedBagCream,
              background: colors.uniformGreen,
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            Done
          </button>
        </div>
      )}

      <p style={styles.subtitle}>
        {data?.hasDraft ? 'Changes saved for review' : 'Current product details'}
      </p>

      <div style={{ display: 'flex', gap: 32, marginTop: 24, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px', maxWidth: 300 }}>
          <div style={{
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: 12,
            padding: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: 260,
            overflow: 'hidden',
          }}>
            <ProductImage
              src={imageUrl}
              alt={decodeHtmlEntities(nameVal)}
              title={decodeHtmlEntities(nameVal)}
            />
          </div>
          {primaryImage && (
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 10, textAlign: 'center', fontFamily: 'monospace' }}>
              📁 {primaryImage}
            </div>
          )}
        </div>
        
        <div style={{ flex: '2 2 300px' }}>
          {nameField && renderFieldInput(nameField)}
          
          {otherPinnedFields.length > 0 && (
            <div style={styles.grid}>
              {otherPinnedFields.map(e => renderFieldInput(e))}
            </div>
          )}
          
          {descField && renderFieldInput(descField)}
          
          {/* Collapsable Remaining Fields */}
          {additionalFieldsList.length > 0 && (
            <div style={{ marginTop: 24, marginBottom: 16 }}>
              <button
                onClick={() => setShowAllFields(prev => !prev)}
                type="button"
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '12px 16px',
                  fontSize: 14,
                  fontWeight: 600,
                  color: '#475569',
                  background: '#f8fafc',
                  border: '1px solid #e2e8f0',
                  borderRadius: 8,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
              >
                <span>📦 {showAllFields ? 'Hide' : 'Show'} more product details ({additionalFieldsList.length})</span>
                <span style={{ transform: showAllFields ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>▼</span>
              </button>
              {showAllFields && (
                <div style={{
                  marginTop: 12,
                  padding: 16,
                  background: '#ffffff',
                  border: '1px solid #e2e8f0',
                  borderRadius: 8,
                  animation: 'slideDown 0.25s ease-out',
                }}>
                  <div style={styles.grid}>
                    {additionalFieldsList.map(e => renderFieldInput(e))}
                  </div>
                </div>
              )}
            </div>
          )}

          {error && <div style={styles.error}>{error}</div>}
          {message && <div style={styles.message}>{message}</div>}

          <div style={styles.buttonRow}>
            <button style={styles.button} onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save for review'}
            </button>
          </div>
          
          <p style={styles.info}>Your changes will be saved for review. They will not appear in your store until you approve them.</p>
        </div>
      </div>

      {/* Product Media Gallery */}
      <div style={{
        marginTop: 32,
        padding: 24,
        background: '#f8fafc',
        border: '1px solid #e2e8f0',
        borderRadius: 16,
      }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', marginBottom: 4 }}>📸 Product Media Gallery</h3>
        <p style={{ fontSize: 13, color: '#64748b', marginBottom: 16 }}>
          Rearrange images using the arrows. The first image is the <strong>Primary Image</strong>, and the others are additional images (up to 20).
        </p>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {images.map((img, idx) => {
            const isPrimary = idx === 0;
            const itemImgUrl = img ? (mediaUrl ? (mediaUrl.endsWith('/') ? mediaUrl : mediaUrl + '/') + img : '') : '';
            return (
              <div key={`${img}-${idx}`} className={`image-card ${isPrimary ? 'image-card-primary' : ''}`}>
                {isPrimary && (
                  <span style={{
                    position: 'absolute',
                    top: 8,
                    left: 8,
                    zIndex: 10,
                    background: '#2563eb',
                    color: '#ffffff',
                    fontSize: 10,
                    fontWeight: 600,
                    padding: '2px 6px',
                    borderRadius: 4,
                    boxShadow: '0 2px 4px rgba(37,99,235,0.2)',
                  }}>
                    Primary
                  </span>
                )}
                
                <div className="image-action-overlay">
                  {idx > 0 ? (
                    <button
                      title="Move Left"
                      onClick={() => moveImage(idx, 'left')}
                      className="image-action-btn"
                    >
                      ←
                    </button>
                  ) : <div />}
                  
                  {idx > 0 && (
                    <button
                      title="Make Primary"
                      onClick={() => setAsPrimary(idx)}
                      className="image-action-btn"
                      style={{ fontSize: 10 }}
                    >
                      ⭐
                    </button>
                  )}

                  {idx < images.length - 1 ? (
                    <button
                      title="Move Right"
                      onClick={() => moveImage(idx, 'right')}
                      className="image-action-btn"
                    >
                      →
                    </button>
                  ) : <div />}

                  <button
                    title="Remove"
                    onClick={() => removeImage(idx)}
                    className="image-action-btn image-action-btn-danger"
                  >
                    🗑️
                  </button>
                </div>

                <div style={{
                  width: '100%',
                  height: 100,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: '#f1f5f9',
                  borderRadius: 6,
                  overflow: 'hidden',
                  marginTop: isPrimary ? 24 : 8,
                }}>
                  <ProductImage src={itemImgUrl} alt={img} title={img} />
                </div>

                <div style={{
                  fontSize: 10,
                  color: '#475569',
                  fontWeight: 500,
                  width: '100%',
                  textAlign: 'center',
                  fontFamily: 'monospace',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  paddingTop: 8,
                }} title={img}>
                  {img}
                </div>
              </div>
            );
          })}

          {images.length < 21 && (
            <div className="image-card add-image-card" style={{ justifyContent: 'center' }}>
              {!showAddImageInput ? (
                <div
                  onClick={() => setShowAddImageInput(true)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#64748b',
                    width: '100%',
                    height: '100%',
                  }}
                >
                  <span style={{ fontSize: 24, fontWeight: 300, marginBottom: 4 }}>+</span>
                  <span style={{ fontSize: 11, fontWeight: 500 }}>Add Image</span>
                </div>
              ) : (
                <div style={{
                  padding: 8,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  width: '100%',
                  height: '100%',
                  justifyContent: 'center',
                }}>
                  <input
                    type="text"
                    placeholder="image.jpg"
                    value={newImageName}
                    onChange={e => setNewImageName(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '4px 8px',
                      fontSize: 11,
                      border: '1px solid #cbd5e1',
                      borderRadius: 4,
                      boxSizing: 'border-box',
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') addImage();
                    }}
                    autoFocus
                  />
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      onClick={addImage}
                      style={{
                        flex: 1,
                        padding: '4px 0',
                        background: '#2563eb',
                        color: '#ffffff',
                        border: 'none',
                        borderRadius: 4,
                        fontSize: 10,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      Add
                    </button>
                    <button
                      onClick={() => {
                        setShowAddImageInput(false);
                        setNewImageName('');
                      }}
                      style={{
                        flex: 1,
                        padding: '4px 0',
                        background: '#e2e8f0',
                        color: '#475569',
                        border: 'none',
                        borderRadius: 4,
                        fontSize: 10,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

      <CatalogClassificationPanel sku={sku} onDraftCreated={() => {}} />
      </div>
    </div>
  );
}
