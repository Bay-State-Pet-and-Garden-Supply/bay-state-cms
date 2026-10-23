import React, { useState } from 'react';
import { ProductsView } from './catalog-workbench/ProductsView';
import { OverviewView } from './catalog-workbench/OverviewView';
import { CatalogFieldsView } from './catalog-workbench/CatalogFieldsView';
import { TypesAttributesView } from './catalog-workbench/TypesAttributesView';
import { CategoryPagesView } from './catalog-workbench/CategoryPagesView';
import { MappingsView } from './catalog-workbench/MappingsView';
import { SchemaHealthView } from './catalog-workbench/SchemaHealthView';
import { WorkbenchTabs, WORKBENCH_TAB_CSS } from './catalog-workbench/WorkbenchTabs';
import { ViewHeader } from './common/ViewHeader';
import { WORKBENCH_TABS } from './catalog-workbench/types';

interface Props {
  onSelectProduct: (sku: string) => void;
  onShowChangeSets?: () => void;
}

const CONTAINER_STYLE: React.CSSProperties = {
  padding: 24,
  maxWidth: 1400,
  margin: '0 auto',
};

export function Catalog({ onSelectProduct, onShowChangeSets }: Props) {
  const [activeTab, setActiveTab] = useState('products');

  return (
    <div style={CONTAINER_STYLE}>
      <style>{WORKBENCH_TAB_CSS}</style>
      <ViewHeader
        title="Product catalog"
        description="Find products and review the details saved for your store."
      />
      <WorkbenchTabs
        tabs={WORKBENCH_TABS}
        active={activeTab}
        onChange={setActiveTab}
      />

      {activeTab === 'products' && (
        <ProductsView
          onSelectProduct={onSelectProduct}
        />
      )}
      {activeTab === 'overview' && <OverviewView />}
      {activeTab === 'fields' && <CatalogFieldsView onSelectProduct={onSelectProduct} />}
      {activeTab === 'types' && <TypesAttributesView />}
      {activeTab === 'pages' && <CategoryPagesView />}
      {activeTab === 'mappings' && <MappingsView />}
      {activeTab === 'health' && <SchemaHealthView onSelectProduct={onSelectProduct} />}
    </div>
  );
}
