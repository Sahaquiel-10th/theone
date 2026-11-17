package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type codexExecutionOwner struct {
	WorkspaceID string `json:"workspaceId"`
	UserID string `json:"userId"`
}
type codexReceiptIdentity struct {
	WorkspaceID string `json:"workspaceId"`
	UserID string `json:"userId"`
	DeviceID string `json:"deviceId"`
	InstallationID string `json:"installationId"`
	AttemptID string `json:"attemptId"`
	TaskID string `json:"taskId"`
	Round int `json:"round"`
}
type codexTerminalReceipt struct {
	Type string `json:"type"`
	SchemaVersion int `json:"schemaVersion"`
	ReceiptID string `json:"receiptId"`
	ReceiptHash string `json:"receiptHash"`
	codexReceiptIdentity
	Outcome string `json:"outcome"`
	FinalResponse string `json:"finalResponse"`
	Error string `json:"error,omitempty"`
	TargetName string `json:"targetName,omitempty"`
	ProviderThreadID string `json:"providerThreadId,omitempty"`
	OccurredAt string `json:"occurredAt"`
}
type codexReceiptEntry struct {
	Identity codexReceiptIdentity `json:"identity"`
	Receipt *codexTerminalReceipt `json:"receipt,omitempty"`
	Acknowledged bool `json:"acknowledged"`
	TargetName string `json:"targetName,omitempty"`
	ThreadID string `json:"threadId,omitempty"`
}
type codexReceiptJournal struct {
	mu sync.Mutex
	root string
	replace func(string,string) error
}

func codexHash(fields ...string) string {
	h := sha256.New()
	for _, field := range fields { fmt.Fprintf(h, "%d:", len([]byte(field))); h.Write([]byte(field)) }
	return hex.EncodeToString(h.Sum(nil))
}
func codexRandomID() string { bytes := make([]byte, 16); if _,err:=rand.Read(bytes);err!=nil{return ""};return hex.EncodeToString(bytes) }
func (id codexReceiptIdentity) valid() bool {
	for _, value := range []string{id.WorkspaceID,id.UserID,id.DeviceID,id.InstallationID,id.AttemptID,id.TaskID} {
		if !codexProtocolID.MatchString(value) { return false }
	}
	return id.Round >= 0 && id.Round <= 1_000_000
}
func (id codexReceiptIdentity) key() string { return codexHash(id.WorkspaceID,id.UserID,id.DeviceID,id.InstallationID,id.AttemptID,id.TaskID,strconv.Itoa(id.Round)) }
func (receipt codexTerminalReceipt) hash() string {
	return codexHash("one-terminal-receipt-v1",receipt.ReceiptID,receipt.AttemptID,receipt.WorkspaceID,receipt.UserID,receipt.DeviceID,receipt.InstallationID,receipt.TaskID,strconv.Itoa(receipt.Round),receipt.Outcome,receipt.FinalResponse,receipt.Error,receipt.TargetName,receipt.ProviderThreadID,receipt.OccurredAt)
}
func (receipt codexTerminalReceipt) valid() bool {
	return receipt.Type=="execution_terminal_receipt" && receipt.SchemaVersion==1 && receipt.codexReceiptIdentity.valid() && receipt.ReceiptID!="" && receipt.ReceiptHash==receipt.hash() && len(receipt.FinalResponse)<=480_000 && (receipt.Outcome=="completed"||receipt.Outcome=="cancelled"||receipt.Outcome=="failed")
}
func newCodexTerminalReceipt(id codexReceiptIdentity,outcome,text,code,target,thread string) codexTerminalReceipt {
	r:=codexTerminalReceipt{Type:"execution_terminal_receipt",SchemaVersion:1,ReceiptID:codexRandomID(),codexReceiptIdentity:id,Outcome:outcome,FinalResponse:text,Error:code,TargetName:target,ProviderThreadID:thread,OccurredAt:time.Now().UTC().Format(time.RFC3339Nano)}
	r.ReceiptHash=r.hash()
	return r
}
func (journal *codexReceiptJournal) filename(id codexReceiptIdentity) string { return filepath.Join(journal.root,id.key()+".json") }
func (journal *codexReceiptJournal) read(id codexReceiptIdentity) (*codexReceiptEntry,error) {
	if !id.valid() { return nil,errors.New("本机任务身份无效") }
	file:=journal.filename(id)
	if err:=managedCheckPath(file);err!=nil{return nil,err}
	data,err:=os.ReadFile(file)
	if os.IsNotExist(err){return nil,nil}
	if err!=nil||len(data)>1024*1024{return nil,errors.New("本机结果记录无法读取")}
	var entry codexReceiptEntry
	if managedDecode(data,&entry)!=nil||entry.Identity!=id||entry.Receipt!=nil&&(!entry.Receipt.valid()||entry.Receipt.codexReceiptIdentity!=id){return nil,errors.New("本机结果记录校验失败")}
	return &entry,nil
}
func (journal *codexReceiptJournal) write(entry codexReceiptEntry) error {
	if !entry.Identity.valid(){return errors.New("本机任务身份无效")}
	if err:=managedCheckPath(journal.root);err!=nil{return err}
	if err:=os.MkdirAll(journal.root,0700);err!=nil{return err}
	data,err:=json.Marshal(entry)
	if err!=nil{return err}
	return writeWorkFolderConfig(journal.filename(entry.Identity),string(data),journal.replace)
}
func (journal *codexReceiptJournal) reserve(id codexReceiptIdentity,target string) (*codexReceiptEntry,error) {
	journal.mu.Lock();defer journal.mu.Unlock()
	entry,err:=journal.read(id)
	if err!=nil||entry!=nil{return entry,err}
	entry=&codexReceiptEntry{Identity:id,TargetName:target}
	return nil,journal.write(*entry)
}
func (journal *codexReceiptJournal) thread(id codexReceiptIdentity,thread string) error {
	journal.mu.Lock();defer journal.mu.Unlock()
	entry,err:=journal.read(id)
	if err!=nil||entry==nil{return errors.New("原任务执行记录不可用")}
	if entry.ThreadID!=""&&entry.ThreadID!=thread{return errors.New("原任务执行会话发生冲突")}
	entry.ThreadID=thread
	return journal.write(*entry)
}
func (journal *codexReceiptJournal) complete(receipt codexTerminalReceipt) (codexTerminalReceipt,error) {
	journal.mu.Lock();defer journal.mu.Unlock()
	if !receipt.valid(){return codexTerminalReceipt{},errors.New("本机结果回执无效")}
	entry,err:=journal.read(receipt.codexReceiptIdentity)
	if err!=nil||entry==nil{return codexTerminalReceipt{},errors.New("原任务执行记录不可用")}
	if entry.Receipt!=nil{return *entry.Receipt,nil}
	entry.Receipt=&receipt
	return receipt,journal.write(*entry)
}
func (journal *codexReceiptJournal) acknowledge(id codexReceiptIdentity,receiptID,hash string,accepted bool) error {
	journal.mu.Lock();defer journal.mu.Unlock()
	entry,err:=journal.read(id)
	if err!=nil||entry==nil||entry.Receipt==nil||!accepted||entry.Receipt.ReceiptID!=receiptID||entry.Receipt.ReceiptHash!=hash{return errors.New("本机结果确认未匹配原回执")}
	entry.Acknowledged=true
	return journal.write(*entry)
}
func (journal *codexReceiptJournal) pending(owner codexExecutionOwner,device,installation string,active map[string]bool) ([]codexTerminalReceipt,error) {
	journal.mu.Lock();defer journal.mu.Unlock()
	if err:=managedCheckPath(journal.root);err!=nil{return nil,err}
	files,err:=os.ReadDir(journal.root)
	if os.IsNotExist(err){return nil,nil}
	if err!=nil{return nil,err}
	var receipts []codexTerminalReceipt
	for _,file:=range files {
		if file.IsDir()||!strings.HasSuffix(file.Name(),".json"){continue}
		data,err:=os.ReadFile(filepath.Join(journal.root,file.Name()))
		if err!=nil||len(data)>1024*1024{return nil,errors.New("本机结果记录无法读取")}
		var raw codexReceiptEntry
		if managedDecode(data,&raw)!=nil{return nil,errors.New("本机结果记录校验失败")}
		id:=raw.Identity
		if id.WorkspaceID!=owner.WorkspaceID||id.UserID!=owner.UserID||id.DeviceID!=device||id.InstallationID!=installation{continue}
		entry,err:=journal.read(id)
		if err!=nil||entry==nil{return nil,errors.New("本机结果记录校验失败")}
		if active[id.AttemptID]||entry.Acknowledged{continue}
		if entry.Receipt==nil {
			receipt:=newCodexTerminalReceipt(id,"failed","启动器在上轮执行期间退出了，结果尚未确认。已有任务和成果可继续查看。","launcher_interrupted",entry.TargetName,entry.ThreadID)
			entry.Receipt=&receipt
			if err:=journal.write(*entry);err!=nil{return nil,err}
		}
		receipts=append(receipts,*entry.Receipt)
	}
	return receipts,nil
}
