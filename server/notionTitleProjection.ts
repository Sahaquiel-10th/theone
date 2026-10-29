/** A server-owned representation boundary, not a relaxed content comparison.
 * A leading authored H1 becomes Notion's page-title property; the remaining
 * body is sent unchanged. The exact source prefix is retained for readback. */
export type NotionTitleProjection={version:1;title:string;prefix:string};

export function projectNotionLeadingTitle(source:string):(NotionTitleProjection&{content:string})|undefined{
 const match=/^(# ([^\r\n]+))(\r?\n(?:[ \t]*\r?\n)*)([\s\S]+)$/.exec(source);
 if(!match)return;
 const title=match[2],content=match[4];
 // Do not guess how inline Markdown, trailing heading markers, or escaped
 // titles map to a property. Those documents retain their original path.
 if(title!==title.trim()||title.length>200||/[\\`*_~\[\]<>\{\}|]/.test(title)||/\s#+$/.test(title)||!content.trim())return;
 return {version:1,title,prefix:match[1]+match[3],content};
}

export function notionProjectedSource(body:string,title:string|undefined,projection?:NotionTitleProjection){
 if(!projection)return body;
 // Old receipts never acquire this marker implicitly. A property is part of
 // the actual saved document and must be read, not inferred from our request.
 if(projection.version!==1||title!==projection.title)return;
 return projection.prefix+body;
}
