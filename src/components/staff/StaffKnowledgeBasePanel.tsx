import React, { useMemo, useState } from 'react';
import { HelpCircle, Search } from 'lucide-react';
import type { KnowledgeArticle } from '../../types';

interface StaffKnowledgeBasePanelProps {
  articles: KnowledgeArticle[];
}

const CATEGORIES = ['all', 'recipes', 'opening', 'closing', 'cleaning'] as const;

const StaffKnowledgeBasePanel: React.FC<StaffKnowledgeBasePanelProps> = ({ articles }) => {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('all');

  const filteredArticles = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return articles.filter((article) => {
      const matchesText = !needle
        || article.title.toLowerCase().includes(needle)
        || article.content.toLowerCase().includes(needle);
      const matchesCategory = category === 'all' || article.category === category;
      return matchesText && matchesCategory;
    });
  }, [articles, category, search]);

  return (
    <div className="space-y-6 text-left">
      <div className="bg-white p-6 rounded-3xl border border-[#EBDECE] flex flex-col md:flex-row items-center gap-4">
        <div className="relative flex-1 w-full">
          <Search className="absolute left-4 top-3.5 h-4 w-4 text-[#A46832]" />
          <input
            id="kb-search-input"
            type="text"
            placeholder="Search operations recipes, sanitisation routines, close guides..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="w-full pl-12 pr-4 py-3.5 bg-[#FFFFFF] border border-[#EBDECE] rounded-full text-xs focus:ring-1 focus:ring-[#A46832] focus:outline-none"
          />
        </div>

        <div className="flex gap-2 pb-1 overflow-x-auto w-full md:w-auto">
          {CATEGORIES.map((item) => (
            <button
              id={`kb-cat-filter-${item}`}
              key={item}
              type="button"
              onClick={() => setCategory(item)}
              className={`px-4 py-2 rounded-full text-2xs uppercase font-extrabold whitespace-nowrap cursor-pointer ${
                category === item ? 'bg-[#A46832] text-white' : 'bg-stone-100 text-[#2E2A26]'
              }`}
            >
              {item}
            </button>
          ))}
        </div>
      </div>

      {filteredArticles.length === 0 ? (
        <div className="bg-white p-12 text-center rounded-3xl border">
          <HelpCircle className="h-8 w-8 text-[#A46832] mx-auto mb-2" />
          <p className="text-xs font-bold font-display uppercase">No operations guides located.</p>
          <p className="text-2xs text-gray-400 mt-1">Try entering “Allergen” or “Calibrate”.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {filteredArticles.map((article) => (
            <article key={article.id} className="bg-white p-6 rounded-3xl border border-[#EBDECE]/40 shadow-2xs space-y-4">
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-[#A46832] font-extrabold uppercase tracking-widest">{article.category}</span>
                  <span className="text-gray-400 font-mono">Updated: {article.lastUpdated}</span>
                </div>
                <h3 className="font-display font-black text-xs uppercase tracking-wide">{article.title}</h3>
                <p className="text-2xs text-gray-500 font-mono">Author: {article.author} • Read Space: {article.readingTime}</p>
              </div>

              <p className="text-2xs text-gray-600 leading-relaxed font-light">{article.content}</p>

              {article.steps && (
                <div className="space-y-2 border-t border-gray-100 pt-3">
                  <span className="text-[9px] uppercase font-black text-[#A46832] tracking-widest block">Core Calibration Steps</span>
                  <ol className="space-y-1 text-2xs text-gray-600 font-light list-decimal list-inside pl-1">
                    {article.steps.map((step, index) => <li key={`${article.id}-step-${index}`}>{step}</li>)}
                  </ol>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
};

export default React.memo(StaffKnowledgeBasePanel);
