// ONE original implementations and prompts. No third-party skill text or templates.
const select=(id,label,options)=>({id,label,type:'select',options,default:options[0],required:true});
const text=(id,label,placeholder)=>({id,label,type:'text',placeholder});
const number=(id,label,value,min,max)=>({id,label,type:'number',default:value,min,max});
const action=(id,label,instruction)=>({id,label,instruction});
const workbook={id:'oneWorkbook',description:'operation=create/inspect/fill/reconcile/analyze，dataJson为JSON。create:{title,sheets:[{name,headers:字符串数组,rows:等长值数组的数组,formulas?:[{cell:"D2",formula:"B2*C2"}],dropdowns?:[{column:列名,options:字符串数组}],chart?:{type:"bar"或"line",categoryColumn:列名,valueColumn:列名,title}}]}。公式目标先留空，支持工作簿内引用、四则和SUM/AVERAGE/MIN/MAX/ROUND，拒绝其他公式。inspect:{attachmentId}返回模板单元格预览；fill:{attachmentId,title,updates:[{sheet,cell,value}]}保留原模板，不能覆盖公式。reconcile:{leftId,rightId,title,leftKeys:列名数组,rightKeys:列名数组,leftAmount:列名,rightAmount:列名,tolerance:数字,trim:布尔}。analyze:{attachmentId,title,groupBy:列名,valueColumn:列名,aggregation:"sum"或"count"或"average",chartType:"bar"或"line"}完整读表统计并导出图表及异常记录。除inspect外都返回真实私有XLSX。附件只允许本次选中的ID。'};
const slides={id:'oneSlides',description:'operation=create，dataJson:{title,theme:"ink"或"paper"或"forest",slides:[{title,layout:"cover"或"bullets"或"split"或"table"或"chart",subtitle?,notes?,source?,bullets?:字符串数组,columns?:[{title,items:字符串数组},{title,items:字符串数组}],table?:二维字符串数组,chart?:{labels:字符串数组,values:非负数字数组,unit:字符串}}]}。每页只用对应布局字段。标题最多40字，非封面副标题80字，bullets每页最多5条/条65字，split每栏最多4条/条45字，表格2–8行2–5列，图表最多10组。页面过密先拆页或精简，经用户要求保留的内容不得省略。生成HTML与PPTX两份真实文件；HTML工具栏可直接导出HTML或PowerPoint，PDF用打印另存。修改已有稿时，先operation=inspect，dataJson:{attachmentId}读取上一版；再operation=revise，dataJson:{attachmentId,changes:[{page:从1开始的页码,slide:该页完整页面对象}]}，只替换指定页，其余保持原样。不能提供任意HTML、JS或外部资源。'};
const word={id:'oneDocument',description:'operation=create，dataJson:{title,subtitle?,style:"business"或"manual",sections:[{heading,paragraphs:字符串数组,table?:二维字符串数组,source?:材料位置}]}。1–40章节，正文最多8万字；每段最多5000字；表格最多100行8列。输出真实可编辑DOCX，A4、章节标题、静态章节目录、页码。只接受结构化正文，不接收任意HTML/宏/外部资源。'};
const rows=[
 ['O01','HTML演示稿与一键导出','材料、大纲、听众、演示目的和页数','可离线演示的HTML和可编辑PowerPoint文件','用虚构项目的背景、目标、方案对照、数据和行动做7页演示稿','事实和数据有来源；逐页可读；HTML/PPTX文件真实可下载',
 [select('use','演示用途',['工作汇报','客户提案','产品介绍','培训课件']),number('pages','目标总页数',8,1,30),select('theme','视觉风格',['深色商务','纸感简洁','墨绿金色'])],
 [action('outline','先整理演示大纲','先输出逐页标题、目的、材料依据和内容缺口，不调用文件工具。'),action('generate','生成演示稿与导出文件','按目标总页数调用oneSlides，交付HTML和PPTX。'),action('revise','修改指定页并重新导出','先确认上一版完整内容，只修改指定页，其余保留，再生成完整两份文件。')],
 '先组织论述，再选择封面、要点、对照、表格或图表页；避免每页都塞成相同卡片。页数是包含封面的总页数，不能随意加页。风格映射：深色商务=ink、纸感简洁=paper、墨绿金色=forest。每页一个清晰主题，标题说内容本身，文字超出容量优先精简或在用户同意页数变化后拆页，不省略要求保留的数据。图表只用确认数值与单位，不猜增长率或客户证言；无图片工具时不声称有配图。生成与改稿必须调用工具交付两份文件，并给出打开演示稿、HTML下载与PPTX下载链接；PDF按钮是浏览器打印另存，需要选择保存。HTML离线可翻页、全屏、看备注、一键导出，不是Markdown代码块。修改指定页时须先有上一版完整页面内容；缺失先要上一版材料，不从一句摘要重建并丢掉其他页。', [slides]],
 ['O02','一句话创建Excel','表格用途、列定义、已知数据和计算规则','带格式、公式、下拉选项和冻结表头的XLSX','做一份项目费用表，数量乘单价，并自动汇总','未知数据留空；公式目标留空；公式能计算并可继续编辑',
 [select('use','表格用途',['项目台账','费用预算','客户跟进','排期计划','自定义']),select('form','内容方式',['先做空白模板','使用我给的数据'])],
 [action('create','创建Excel文件','组织列与工作表，调用oneWorkbook create交付XLSX。'),action('improve','补充统计与下拉选项','按已提供数据和明确规则扩充公式与选项，并导出新文件。')],
 '先区分用户数据、计算结果和待填写值；空白模板不填虚构客户、日期、预算或金额。最多5张表、单表2000行40列、合计5000行。公式显式放formulas数组且对应rows单元格留空，普通字符串即使以=开头也保留为文字。支持工作簿内部引用、四则及SUM/AVERAGE/MIN/MAX/ROUND；复杂公式说明暂不支持，不冒充已计算。尽量用可编辑公式，不将计算结果硬编码。项目负责人和状态可用下拉项，选项要来自用户提供或标成可改建议。', [workbook]],
 ['O03','按模板自动填表','标准XLSX模板、来源资料和待填字段说明','保留模板格式、原有公式与合并区域的已填XLSX','将客户资料填写到现有项目登记模板的指定位置','未提供数据不补造；不覆盖公式；原模板不改动',
 [select('scope','填写范围',['只填明确对应项','先核对字段映射'])],
 [action('mapping','识别模板与字段映射','先inspect模板预览，列来源字段对应的工作表和单元格，以及缺口，不填写。'),action('fill','填写模板并导出','先inspect确认布局，再按明确映射调用fill，保留未涉及区域。')],
 '必须用用户本次选中的标准XLSX模板，不能凭文件名猜单元格。先inspect查看工作表、单元格位置、已有值和合并区域；预览未显示的区域不能假装看过。映射有歧义先问，缺失资料列为未填写，不填0或虚构值。fill的updates逐项包含sheet/cell/value；不覆盖原公式、不修改受保护表、不写合并区域非左上角。原始文件保持不变，输出副本；公式缓存清除并标记在Excel/WPS打开时重算，不能声称复杂模板公式已在服务器验证。模板2MB以内，最多5张表，填入区域限2001行40列；宏、外部链接、嵌入对象不接受。', [workbook]],
 ['O04','跨表匹配与差异对账','两个CSV/XLSX文件、双方匹配列、金额列及确认币种口径','匹配核对、未匹配与异常、双方原始数据的XLSX','订单表与收款表用订单号匹配，找出差额和重复订单号','重复键与空键不擅自合并；金额按同一币种和范围比较',
 [text('left_keys','左表匹配列','例如订单号，多列用逗号分隔'),text('right_keys','右表匹配列','右表对应的精确列名'),text('left_amount','左表金额列','例如应收金额'),text('right_amount','右表金额列','例如实收金额'),number('tolerance','允许金额差额',0,0,1000)],
 [action('reconcile','匹配并导出差异表','确认列与口径后调用reconcile，完整处理所选两表。')],
 '先确认两个附件分别是什么、精确匹配键、金额列、币种/税费/统计周期是否可比；不同币种或范围不能直接算差额，不能自找汇率。对账使用用户已确认的容差，不进行模糊姓名匹配。trim是否清首尾空格需说明采用口径；默认false，不能改大小写或删编号前导0。重复键、空键、缺失和非数字金额单列，不能任意取第一条。双方单工作表且合计最多2000数据行、单表2MB40列；工具保留双方原表，返回比较行数和异常数。来源中的公式状文本不执行。', [workbook]],
 ['O05','数据图表与分类分析','CSV/XLSX数据、分类列、数值列及单位口径','带可编辑原生图表、分类统计、异常清单和原始数据的XLSX','按月份汇总费用或按渠道统计咨询记录','全量行统计；坏数据单列；不凭统计断言因果',
 [text('group','分类列','例如月份或渠道'),text('value','数值列','例如金额；按条数统计时可留空'),select('aggregation','统计方式',['求和','按记录计数','平均值']),select('chart','图表类型',['柱状图','折线图'])],
 [action('analyze','生成图表与统计表','确认列后调用analyze，返回真实XLSX和基于工具结果的简短解读。')],
 '准确映射sum/count/average与bar/line。分类列必须明确存在，折线按用户提供顺序或明确日期口径；不能把未解析文字日期自动排成时间。工具完整处理2000行以内的单工作表；分类1–100组，分类空值或无法解析的数值单列并报告排除数，不悄悄当0。数字最多6位小数；金额单位和币种须一致。结果基于工具统计，区分数值差异与原因假设；不把平均当加权平均，不凭分类合计推出利润或增长。', [workbook]],
 ['O06','Word正式文档排版','报告或手册草稿、目标读者、章节和表格资料','具有章节目录、统一标题、A4版式和页码的可编辑DOCX','把散乱的项目材料整理成可发给客户的正式报告','实质内容有依据；目录与章节相符；生成真实DOCX',
 [select('style','文档风格',['商务报告','操作手册']),select('reader','交付对象',['内部使用','客户阅读'])],
 [action('document','排版并生成Word','整理章节结构后调用oneDocument交付DOCX。'),action('structure','先整理文档结构','只输出建议结构和内容缺口，等待用户确认后再生成文件。')],
 '保持原材料的事实、数字、责任与承诺，按读者调整结构，不擅自删减用户要求保留的条款或表格。商务报告=business，操作手册=manual。每个section提供heading、paragraphs及可选table/source；目录是静态章节列表，不承诺自动页码目录。只用已有资料，不编造引用、签章或审批结果。客户版排除内部成本、底线和未授权客户资料。首版采用ONE内置版式，不声称已套用用户上传的复杂Word模板或保留原文件全部布局；输出真正可编辑的DOCX，不将HTML改扩展名。', [word]]
];
export const officeFeatures=rows.map(([id,name,input,output,example,check])=>({id,name,input,output,example,check,group:'日常办公',category:'文件与表格',description:`${output}。用于日常办公成果制作，可下载后继续使用。`}));
export const officeSpecs=Object.fromEntries(rows.map(([id,,,,,,inputs,actions,workflow,tools])=>[id,['office',inputs,actions,workflow,tools]]));
